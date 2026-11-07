"""Where things are in the Rainbow app, and how long to wait for them.

Positions are fractions of the main window (0..1), measured from screenshots of
a 1600x960 window. They are the last fallback, after UI Automation lookup and
template matching. Override anything in `dspgui_config.json` next to where the
server runs (or point CARCAL_DSPGUI_CONFIG at a file).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Target:
    """One clickable thing."""
    uia_name: str | None              # name exposed via UI Automation, if any
    template: str | None              # PNG in templates/
    frac: tuple[float, float]         # fallback position in the main window
    region: tuple[float, float, float, float] = (0, 0, 1, 1)   # template search area
    threshold: float = 0.80
    # Blind position click allowed? Off for dialog buttons: they sit over the EQ
    # sliders, so a click when the dialog didn't open could change an EQ band.
    position_fallback: bool = True


def _ch(n: int, y_px: int) -> Target:
    return Target(f"CH{n}", f"ch{n}.png", (1567 / 1600, y_px / 960),
                  region=(0.93, 0.08, 1.0, 0.42), threshold=0.65)


@dataclass
class GuiConfig:
    # Main window: first top-level window whose title matches, or the process exe.
    main_title_re: str = r"(?i).*(EL-PA|rainbow|dsp).*"
    process_path: str | None = None          # e.g. r"C:\Program Files\Rainbow\DSP.exe"

    open_dialog_title: str = "Open"
    save_dialog_title: str = "Save"
    file_dialog_titles: list[str] = field(default_factory=lambda: ["slect file", "select file"])

    targets: dict[str, Target] = field(default_factory=lambda: {
        "call":        Target("Call", "call.png", (783 / 1600, 79 / 960), region=(0.35, 0.0, 0.70, 0.15)),
        "save_main":   Target("Save", "save_main.png", (866 / 1600, 79 / 960), region=(0.35, 0.0, 0.70, 0.15)),
        "import":      Target("import", "import.png", (1037 / 1600, 609 / 960),
                              region=(0.30, 0.25, 0.75, 0.75), position_fallback=False),
        "save_dialog": Target("Save", "save_dialog.png", (1059 / 1600, 575 / 960),
                              region=(0.30, 0.45, 0.75, 0.75), position_fallback=False),
        "single_file": Target("Single File", None, (699 / 1600, 575 / 960), position_fallback=False),
        "ch1": _ch(1, 123), "ch2": _ch(2, 172), "ch3": _ch(3, 219),
        "ch4": _ch(4, 268), "ch5": _ch(5, 316), "ch6": _ch(6, 364),
    })

    # Timing (seconds)
    dialog_timeout: float = 8.0
    file_write_timeout: float = 10.0
    post_click_delay: float = 0.4
    post_import_settle: float = 2.5     # time for the app to push settings to the amp

    # Template matching
    template_scales: tuple[float, float, int] = (0.5, 2.0, 31)   # min, max, steps


def load(path: str | Path | None = None) -> GuiConfig:
    cfg = GuiConfig()
    path = Path(path or os.environ.get("CARCAL_DSPGUI_CONFIG", "dspgui_config.json"))
    if not path.exists():
        return cfg
    data = json.loads(path.read_text(encoding="utf-8"))
    targets = data.pop("targets", {})
    for k, v in data.items():
        if not hasattr(cfg, k):
            raise KeyError(f"{path}: unknown setting {k!r}")
        setattr(cfg, k, tuple(v) if isinstance(getattr(cfg, k), tuple) else v)
    for name, override in targets.items():
        t = cfg.targets.get(name) or Target(None, None, (0.5, 0.5))
        for k, v in override.items():
            setattr(t, k, tuple(v) if k in ("frac", "region") else v)
        cfg.targets[name] = t
    return cfg


def dump(cfg: GuiConfig) -> str:
    return json.dumps(asdict(cfg), indent=2)
