"""Tests for the DSP-app automation that don't need Windows.

* Template matching runs against real screenshots of the Rainbow app, including
  resized copies that simulate 80 % and 125 % Windows display scaling.
* The service and MCP server run against a fake app that behaves like the real
  one (holds a preset; import loads a file, export writes it back).
"""

import asyncio
import json
import warnings
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from carcal.dsp_codec import Preset
from carcal.dspgui.config import GuiConfig, load
from carcal.dspgui.locate import find_template, frac_to_screen, load_template
from carcal.dspgui.service import DspService

warnings.simplefilter("ignore")
HERE = Path(__file__).parent
FIX = HERE / "fixtures"
CLEAN = HERE.parent / "samples_clean_default.dspSingle"
CFG = GuiConfig()


def screen(name: str, scale: float = 1.0) -> np.ndarray:
    im = Image.open(FIX / name).convert("RGB")
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    return np.array(im)


def locate(target: str, img: np.ndarray):
    t = CFG.targets[target]
    return find_template(img, load_template(t.template), t.region, CFG.template_scales)


# ---------------- template matching on real screenshots ----------------
CASES = [
    ("call", "app_main.jpg", (783, 79)),
    ("save_main", "app_main.jpg", (866, 79)),
    ("import", "app_open_dialog.jpg", (1037, 609)),
    ("save_dialog", "app_save_dialog.jpg", (1059, 575)),
    ("save_main", "app_save_dialog.jpg", (866, 79)),     # main Save still found with dialog open
]


@pytest.mark.parametrize("scale", [0.8, 1.0, 1.25])
@pytest.mark.parametrize("target,shot,expect", CASES)
def test_template_finds_button(target, shot, expect, scale):
    m = locate(target, screen(shot, scale))
    assert m is not None and m.score >= CFG.targets[target].threshold, (target, scale, m)
    ex, ey = expect[0] * scale, expect[1] * scale
    assert abs(m.center[0] - ex) < 12 * scale and abs(m.center[1] - ey) < 10 * scale


def test_dialog_save_not_confused_with_main_save():
    m = locate("save_dialog", screen("app_save_dialog.jpg"))
    assert m.center[1] > 400          # the dialog's button, not the toolbar one


def test_import_not_found_when_dialog_closed():
    m = locate("import", screen("app_main.jpg"))
    assert m is None or m.score < CFG.targets["import"].threshold


@pytest.mark.parametrize("n", [1, 2, 3, 4, 5, 6])
def test_channel_buttons(n):
    m = locate(f"ch{n}", screen("app_main.jpg"))
    y_expect = [123, 172, 219, 268, 316, 364][n - 1]
    assert m is not None and m.score >= CFG.targets[f"ch{n}"].threshold
    assert abs(m.center[1] - y_expect) < 12, (n, m)


def test_dialog_buttons_never_click_blind():
    for name in ("import", "save_dialog", "single_file"):
        assert CFG.targets[name].position_fallback is False


def test_fraction_fallback_lands_on_button():
    rect = (100, 50, 1700, 1010)                  # window at an offset, 1600x960
    assert frac_to_screen(rect, CFG.targets["call"].frac) == (100 + 783, 50 + 79)


def test_config_override(tmp_path):
    f = tmp_path / "c.json"
    f.write_text(json.dumps({"main_title_re": "Rainbow.*",
                             "targets": {"call": {"frac": [0.5, 0.1]}}}))
    c = load(f)
    assert c.main_title_re == "Rainbow.*"
    assert c.targets["call"].frac == (0.5, 0.1)
    assert c.targets["call"].template == "call.png"     # untouched fields kept


# ---------------- service + server with a fake app ----------------
class FakeApp:
    """Holds a preset like the real app. Optionally clamps EQ to ±12 dB on import."""

    def __init__(self, start: Path, clamp: bool = False):
        self.state = json.loads(start.read_bytes())
        self.clamp = clamp
        self.log: list[str] = []
        self.selected = 1

    def status(self):
        return {"window_found": True, "connected": False}

    def screenshot(self):
        return Image.new("RGB", (1600, 960), (20, 30, 60))

    def import_preset(self, path):
        self.log.append(f"import {Path(path).name}")
        d = json.loads(Path(path).read_bytes())
        if self.clamp:
            for o in d["outPuts"]["outPut"]:
                for b in o["EQ"]:
                    b["level"] = max(480, min(720, b["level"]))
        self.state = d
        return []

    def export_preset(self, path):
        self.log.append(f"export {Path(path).name}")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(json.dumps(self.state, separators=(",", ":")).encode())
        return []

    def select_channel(self, n):
        self.selected = n
        return "fake"


@pytest.fixture
def svc(tmp_path):
    return DspService(FakeApp(CLEAN), tmp_path)


def test_first_import_backs_up_current_state(svc, tmp_path):
    svc.import_preset(CLEAN)
    assert svc.app.log[0].startswith("export backup_")
    assert svc.app.log[1] == "import samples_clean_default.dspSingle"
    svc.import_preset(CLEAN)                       # no second backup
    assert sum(x.startswith("export backup_") for x in svc.app.log) == 1


def test_load_solo_rr(svc):
    r = svc.load_solo(["RR"])
    assert r["playing"] == ["RR"] and r["verified"]
    mutes = [o["mute"] for o in svc.app.state["outPuts"]["outPut"]]
    assert mutes == [0, 0, 0, 1, 0, 0]
    # baseline captured from the app first, so the user's crossovers are kept
    assert svc.app.state["outPuts"]["outPut"][3]["hFreq"] == 80
    assert any("mute" in w for w in r["warnings"])  # mute value still unconfirmed


def test_restore_baseline(svc):
    svc.load_solo(["SUB"])
    svc.restore_baseline()
    assert [o["mute"] for o in svc.app.state["outPuts"]["outPut"]] == [1] * 6


def test_verify_reports_clamping(tmp_path):
    s = DspService(FakeApp(CLEAN, clamp=True), tmp_path)
    p = Preset.load(CLEAN)
    p.set_band_raw("FL", 17, level=900)
    f = tmp_path / "loud.dspSingle"
    p.save(f)
    r = s.import_preset(f)
    assert not r["verified"]
    assert "sent 900, app has 720" in r["mismatches"][0]


def test_run_probe_screens_every_channel(svc):
    res, shots = svc.run_probe("05")
    assert [l for l, _ in shots] == [f"CH{n}" for n in range(1, 7)]
    assert res["app_changed_values"] == []
    assert Path(res["back_file"]).exists()


def _call(server, name, args=None):
    return asyncio.run(server.call_tool(name, args or {}))


def test_mcp_server_tools(svc):
    from carcal.dspgui.server import build_server
    server = build_server(svc)
    names = {t.name for t in asyncio.run(server.list_tools())}
    assert {"dsp_status", "dsp_import", "dsp_export", "dsp_load_solo", "dsp_restore_baseline",
            "dsp_screenshot", "dsp_run_probe", "dsp_select_channel", "dsp_info",
            "dsp_diff", "dsp_capture_baseline", "dsp_set_baseline"} <= names

    r = _call(server, "dsp_load_solo", {"channels": ["RR"]})
    assert not r.is_error, r
    assert '"verified": true' in r.content[0].text

    r = _call(server, "dsp_run_probe", {"probe_id": "02"})
    assert "Refused" in r.content[0].text

    r = _call(server, "dsp_screenshot")
    assert r.content[0].type == "image"
