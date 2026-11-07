"""Windows automation of the Rainbow EL-PA4.6 app.

Import:  Call -> "Open" dialog -> import -> "slect file" picker -> path -> Enter
Export:  Save -> "Save" dialog (Single File) -> Save -> "slect file" picker -> path -> Enter

Each button is found in this order:
  1. UI Automation by name   (exact, if the app exposes its controls)
  2. template match          (screenshots cut from the real app, multi-scale)
  3. fixed position          (fraction of the main window)
The file picker is a standard Windows dialog and is driven through UI Automation.

Real mouse clicks are used, so keep the app window visible and don't touch the
mouse while a tool is running. The cursor is put back where it was afterwards.
"""

from __future__ import annotations

import ctypes
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import GuiConfig
from .locate import find_template, frac_to_screen, load_template

log = logging.getLogger("carcal.dspgui")


class AppNotFound(RuntimeError):
    pass


class GuiError(RuntimeError):
    pass


class DspApp(Protocol):
    """What the service layer needs. RainbowApp is the real one; tests use a fake."""

    def status(self) -> dict: ...
    def screenshot(self): ...                          # PIL.Image
    def import_preset(self, path: Path) -> list[str]: ...
    def export_preset(self, path: Path) -> list[str]: ...
    def select_channel(self, n: int) -> str: ...


def _make_dpi_aware() -> None:
    """Make screen coordinates physical pixels, so screenshots and clicks agree."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _wrap(w):
    """WindowSpecification -> wrapper; wrappers pass through."""
    return w.wrapper_object() if hasattr(w, "wrapper_object") else w


def _first(scope, **criteria):
    """First matching descendant of a wrapper, or None."""
    try:
        found = scope.descendants(**criteria)
    except Exception:
        return None
    for el in found:
        try:
            if el.is_visible():
                return el
        except Exception:
            return el
    return found[0] if found else None


def _escape_keys(text: str) -> str:
    """Escape pywinauto send_keys special characters."""
    return re.sub(r"([{}+^%~()\[\]])", r"{\1}", text)


class _Cursor:
    """Context manager that restores the mouse position."""

    def __enter__(self):
        pt = ctypes.wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        self.pos = (pt.x, pt.y)
        return self

    def __exit__(self, *exc):
        ctypes.windll.user32.SetCursorPos(*self.pos)


class RainbowApp:
    def __init__(self, cfg: GuiConfig):
        if sys.platform != "win32":
            raise RuntimeError("RainbowApp only runs on Windows (where the DSP app runs)")
        _make_dpi_aware()
        import ctypes.wintypes  # noqa: F401  (needed by _Cursor)
        from pywinauto import Desktop
        self.cfg = cfg
        self._desktop = Desktop(backend="uia")
        self.last_click_method: dict[str, str] = {}

    # ---------------- windows ----------------
    def _known_titles(self) -> set[str]:
        c = self.cfg
        return {c.open_dialog_title, c.save_dialog_title, *c.file_dialog_titles}

    def main_window(self):
        c = self.cfg
        if c.process_path:
            from pywinauto import Application
            try:
                return _wrap(Application(backend="uia").connect(path=c.process_path).top_window())
            except Exception as e:
                raise AppNotFound(f"no running app at {c.process_path}: {e}") from e
        rx = re.compile(c.main_title_re)
        cands = []
        titles = []
        for w in self._desktop.windows():
            t = w.window_text() or ""
            titles.append(t)
            if t and rx.match(t) and t not in self._known_titles():
                r = w.rectangle()
                cands.append(((r.right - r.left) * (r.bottom - r.top), w))
        if not cands:
            shown = ", ".join(repr(t) for t in titles if t)[:800]
            raise AppNotFound(
                "DSP app window not found. Open the Rainbow app (not minimised). If it is open, "
                f"set main_title_re in dspgui_config.json to match its title. Visible windows: {shown}")
        return max(cands, key=lambda x: x[0])[1]

    def _pid(self, w) -> int:
        return w.process_id()

    def _rect(self, w) -> tuple[int, int, int, int]:
        r = w.rectangle()
        return r.left, r.top, r.right, r.bottom

    def _find_window(self, titles: list[str] | str, pid: int | None = None):
        if isinstance(titles, str):
            titles = [titles]
        for w in self._desktop.windows():
            if (w.window_text() or "") in titles and (pid is None or self._pid(w) == pid):
                return w
        return None

    def _find_dialog(self, main, title: str):
        """App dialogs may be top-level windows or children of the main window."""
        w = self._find_window(title, self._pid(main))
        if w is not None:
            return w
        return _first(main, title=title, control_type="Window")

    def _wait(self, fn, timeout: float, interval: float = 0.15):
        end = time.time() + timeout
        while time.time() < end:
            v = fn()
            if v:
                return v
            time.sleep(interval)
        return None

    # ---------------- clicking ----------------
    def _grab(self, rect) -> np.ndarray:
        from PIL import ImageGrab
        return np.array(ImageGrab.grab(bbox=rect, all_screens=True).convert("RGB"))

    def _click_xy(self, x: int, y: int) -> None:
        from pywinauto import mouse
        mouse.click(button="left", coords=(x, y))

    def click(self, name: str, scope=None, allow_uia: bool = True) -> str:
        """Click a configured target. Returns which method found it."""
        t = self.cfg.targets[name]
        main = self.main_window()
        try:
            main.set_focus()
        except Exception:
            pass
        method = None
        if allow_uia and t.uia_name:
            el = _first(scope or main, title=t.uia_name)
            if el is not None:
                try:
                    el.click_input()
                    method = "uia"
                except Exception as e:
                    log.debug("uia click for %s failed: %s", name, e)
        rect = self._rect(main)
        if method is None and t.template:
            screen = self._grab(rect)
            m = find_template(screen, load_template(t.template), t.region, self.cfg.template_scales)
            if m and m.score >= t.threshold:
                self._click_xy(rect[0] + m.center[0], rect[1] + m.center[1])
                method = f"template {m.score:.2f}"
            elif m:
                log.info("template %s best score %.2f below %.2f", name, m.score, t.threshold)
        if method is None:
            if not t.position_fallback:
                raise GuiError(f"could not find the '{name}' button (the dialog may not have "
                               f"opened). Not clicking blind. Call dsp_screenshot to check.")
            self._click_xy(*frac_to_screen(rect, t.frac))
            method = "position"
        self.last_click_method[name] = method
        log.info("clicked %s via %s", name, method)
        time.sleep(self.cfg.post_click_delay)
        return method

    # ---------------- file picker ----------------
    def _fill_file_dialog(self, dlg, path: Path) -> None:
        from pywinauto.keyboard import send_keys
        e = self._wait(lambda: _first(dlg, title="File name:", control_type="Edit"), 1.5)
        if e is not None:
            try:
                e.set_edit_text(str(path))
                e.type_keys("{ENTER}")
                return
            except Exception as ex:
                log.info("file name box via UIA failed (%s); typing instead", ex)
        dlg.set_focus()
        send_keys("%n")                                  # Alt+N = File name box
        send_keys("^a" + _escape_keys(str(path)), with_spaces=True)
        send_keys("{ENTER}")

    def _run_file_dialog(self, main, path: Path) -> None:
        c = self.cfg
        dlg = self._wait(lambda: self._find_window(c.file_dialog_titles, self._pid(main)),
                         c.dialog_timeout)
        if dlg is None:
            raise GuiError("the Windows file picker ('slect file') did not open. The click "
                           "probably missed: call dsp_screenshot to see the app state.")
        self._fill_file_dialog(dlg, path)
        closed = self._wait(lambda: not self._find_window(c.file_dialog_titles, self._pid(main)),
                            c.dialog_timeout)
        if not closed:
            confirm = self._find_window(["Confirm Save As"], None)
            if confirm is not None:
                confirm.type_keys("y")
                closed = self._wait(lambda: not self._find_window(c.file_dialog_titles),
                                    c.dialog_timeout)
        if not closed:
            raise GuiError("the file picker is still open after entering the path - "
                           "check the path and the file type (*.dspSingle)")

    # ---------------- popups / cleanup ----------------
    def _collect_popups(self, main) -> list[str]:
        """Read and dismiss any message boxes the app opened."""
        notes = []
        pid, main_h = self._pid(main), main.handle
        for w in self._desktop.windows():
            try:
                if self._pid(w) != pid or w.handle == main_h:
                    continue
                title = w.window_text() or ""
                if title in self._known_titles():
                    continue
                texts = [t.window_text() for t in w.descendants(control_type="Text")]
                notes.append(f"app popup '{title}': " + " | ".join(x for x in texts if x))
                w.type_keys("{ENTER}")
            except Exception:
                continue
        return notes

    def _close_dialog(self, main, title: str) -> None:
        d = self._find_dialog(main, title)
        if d is not None:
            try:
                d.close()
            except Exception:
                try:
                    d.type_keys("{ESC}")
                except Exception:
                    pass

    def _cleanup(self, main) -> None:
        for t in self.cfg.file_dialog_titles:
            w = self._find_window(t, self._pid(main))
            if w is not None:
                w.type_keys("{ESC}")
        self._close_dialog(main, self.cfg.open_dialog_title)
        self._close_dialog(main, self.cfg.save_dialog_title)

    # ---------------- public API ----------------
    def status(self) -> dict:
        try:
            main = self.main_window()
        except AppNotFound as e:
            return {"window_found": False, "error": str(e)}
        texts = []
        try:
            texts = [t.window_text() for t in main.descendants(control_type="Text")][:200]
        except Exception:
            pass
        connected = None
        joined = " ".join(texts)
        if "Not Connected" in joined:
            connected = False
        elif re.search(r"\bConnected\b", joined):
            connected = True
        return {"window_found": True, "title": main.window_text(), "rect": self._rect(main),
                "connected": connected, "uia_texts_visible": bool(texts),
                "last_click_methods": self.last_click_method}

    def screenshot(self):
        from PIL import Image
        main = self.main_window()
        return Image.fromarray(self._grab(self._rect(main)))

    def select_channel(self, n: int) -> str:
        if not 1 <= n <= 6:
            raise ValueError("channel must be 1..6")
        return self.click(f"ch{n}")

    def import_preset(self, path: Path) -> list[str]:
        path = Path(path).resolve()
        if not path.exists():
            raise FileNotFoundError(path)
        main = self.main_window()
        with _Cursor():
            self._cleanup(main)
            self.click("call")
            dlg = self._wait(lambda: self._find_dialog(main, self.cfg.open_dialog_title), 2.0)
            self.click("import", scope=dlg, allow_uia=dlg is not None)
            self._run_file_dialog(main, path)
            time.sleep(self.cfg.post_import_settle)
            self._close_dialog(main, self.cfg.open_dialog_title)
            notes = self._collect_popups(main)
        return notes

    def export_preset(self, path: Path) -> list[str]:
        path = Path(path).resolve()
        if path.suffix != ".dspSingle":
            raise ValueError("export path must end with .dspSingle")
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()                    # avoids the "Confirm Save As" prompt
        main = self.main_window()
        with _Cursor():
            self._cleanup(main)
            self.click("save_main")
            dlg = self._wait(lambda: self._find_dialog(main, self.cfg.save_dialog_title), 2.0)
            # Inside the Save dialog, UIA "Save" would be ambiguous with the main button
            # unless the dialog itself was found.
            self.click("save_dialog", scope=dlg, allow_uia=dlg is not None)
            self._run_file_dialog(main, path)
            ok = self._wait(lambda: _stable_json(path), self.cfg.file_write_timeout, 0.3)
            self._close_dialog(main, self.cfg.save_dialog_title)
            notes = self._collect_popups(main)
        if not ok:
            raise GuiError(f"export did not produce a readable file at {path}")
        return notes

    def inspect(self, out: Path) -> Path:
        """Dump visible windows and the main window's control tree (for troubleshooting)."""
        lines = ["# top-level windows"]
        for w in self._desktop.windows():
            try:
                lines.append(f"{w.window_text()!r}  pid={self._pid(w)}  class={w.class_name()!r}")
            except Exception:
                pass
        out = Path(out)
        out.write_text("\n".join(lines) + "\n\n", encoding="utf-8")
        try:
            main = self.main_window()
            tree = out.with_suffix(".tree.txt")
            main.print_control_identifiers(depth=6, filename=str(tree))
            with out.open("a", encoding="utf-8") as f:
                f.write(tree.read_text(encoding="utf-8", errors="replace"))
            tree.unlink()
        except Exception as e:
            with out.open("a", encoding="utf-8") as f:
                f.write(f"(control tree unavailable: {e})\n")
        return out


def _stable_json(path: Path) -> bool:
    """True once the file exists, stops growing and parses as JSON."""
    if not path.exists():
        return False
    s1 = path.stat().st_size
    time.sleep(0.2)
    if path.stat().st_size != s1 or s1 == 0:
        return False
    try:
        json.loads(path.read_bytes())
        return True
    except Exception:
        return False
