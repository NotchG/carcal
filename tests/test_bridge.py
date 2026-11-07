"""DSP bridge: contract behaviour, EL-PA4.6 compilation, apply/verify, auth, fake REW."""

import json
import warnings
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from carcal.bridge.__main__ import write_schema
from carcal.bridge.app import create_app
from carcal.bridge.driver import ElPa46Driver, ManualApp
from carcal.bridge.fake_rew import create_fake_rew
from carcal.bridge.service import BridgeService
from carcal.calib.sim import SimCar, SimDspApp
from carcal.devices import DEVICES
from carcal.dsp_codec import Preset
from carcal.spec import ISO_31

warnings.simplefilter("ignore")
TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}"}
ROOT = Path(__file__).parent.parent


@pytest.fixture
def sim(tmp_path):
    app_ = SimDspApp(DEVICES["EL-PA4.6"]["factory_default"])
    svc = BridgeService(ElPa46Driver(app_), tmp_path, "sim")
    return TestClient(create_app(svc, TOKEN)), app_, svc


def outputs(app_):
    return app_.state["outPuts"]["outPut"]


def test_schema_file_is_current(tmp_path):
    fresh = write_schema(tmp_path / "s.json").read_text()
    assert fresh == (ROOT / "contract" / "preset-v1.schema.json").read_text(), \
        "run: python -m carcal.bridge schema"


def test_auth(sim):
    c, _, _ = sim
    assert c.get("/v1/health").json()["contract"] == "carcal.preset/1"
    assert c.get("/v1/device").status_code == 401
    assert c.get("/v1/device", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/v1/device", headers=H).status_code == 200


def test_device_description(sim):
    c, _, _ = sim
    d = c.get("/v1/device", headers=H).json()
    assert [ch["key"] for ch in d["channels"]] == ["FL", "FR", "RL", "RR", "SUB"]
    eq = d["capabilities"]["eq"]
    assert eq["kind"] == "fixed" and eq["q"] == pytest.approx(7.613) and len(eq["bands_hz"]) == 31
    assert d["capabilities"]["delay"]["writable"] is False
    assert d["status"]["automation"] is True and d["baseline"]["source"] == "factory default"


def test_exact_grid_filters_map_one_to_one(sim):
    c, _, _ = sim
    req = {"name": "grid", "channels": {"FL": {"eq": {"filters": [
        {"type": "PK", "fc_hz": 125, "gain_db": -4.0, "q": 7.613},
        {"type": "PK", "fc_hz": 2500, "gain_db": 2.5, "q": 7.613}]}}}}
    r = c.post("/v1/presets/compile", json=req, headers=H).json()
    assert r["channels"]["FL"]["eq_exact"] is True and r["channels"]["FL"]["fit_max_db"] < 0.01
    f = c.get(r["file"]["url"], headers=H)
    p = Preset(json.loads(f.content))
    assert p.outputs[0]["EQ"][ISO_31.index(125)]["level"] == 560
    assert p.outputs[0]["EQ"][ISO_31.index(2500)]["level"] == 625


def test_rew_txt_free_filters_are_fitted(sim):
    c, _, _ = sim
    txt = ("Filter  1: ON  PK       Fc   140.0 Hz  Gain  -6.00 dB  Q  2.000\n"
           "Filter  2: ON  PK       Fc   3300 Hz   Gain   3.00 dB  Q  1.200\n")
    r = c.post("/v1/presets/compile", json={"channels": {"FR": {"eq": {"rew_txt": txt}}}}, headers=H).json()
    ch = r["channels"]["FR"]
    assert ch["eq_exact"] is False and ch["fit_rms_db"] < 1.0
    assert any("fitted onto the 31 fixed bands" in w for w in r["warnings"])


def test_patch_semantics_and_ignored_settings(sim):
    c, _, _ = sim
    req = {"channels": {
        "FL": {"highpass": {"hz": 90, "slope_db_oct": 12}, "delay_ms": 1.2, "gain_db": -2},
        "SUB": {"lowpass": None},
    }}
    r = c.post("/v1/presets/compile", json=req, headers=H).json()
    p = Preset(json.loads(c.get(r["file"]["url"], headers=H).content))
    fl, fr, sub = p.outputs[0], p.outputs[1], p.outputs[4]
    assert fl["hFreq"] == 90 and fl["hLevel"] == 1                 # 12 dB/oct = code 1
    assert fr["hFreq"] == 70                                        # untouched channel keeps baseline
    assert sub["lLevel"] == 8                                       # null = filter off
    assert any("delay 1.200 ms not written" in x for x in r["ignored"])
    assert any("gain -2.0 dB not written" in x for x in r["ignored"])


def test_unknown_channel_rejected(sim):
    c, _, _ = sim
    r = c.post("/v1/presets/compile", json={"channels": {"CENTER": {"mute": True}}}, headers=H)
    assert r.status_code == 400 and "unknown channels" in r.json()["detail"]
    r = c.post("/v1/presets/compile", json={"channels": {"FL": {"bogus": 1}}}, headers=H)
    assert r.status_code == 422


def test_measure_preset_then_restore_last_tune(sim):
    c, app_, svc = sim
    tune = {"name": "tune", "purpose": "tune", "channels": {"FL": {"eq": {"filters": [
        {"fc_hz": 1000, "gain_db": -3, "q": 7.613}]}}}}
    a = c.post("/v1/presets/apply", json=tune, headers=H).json()
    assert a["applied"] and a["verified"] and a["backup_id"]          # first load backs up
    tune_level = outputs(app_)[0]["EQ"][ISO_31.index(1000)]["level"]
    assert tune_level == 570

    solo = {"name": "measure RR", "purpose": "measure", "channels": {
        k: {"mute": k != "RR"} for k in ["FL", "FR", "RL", "RR", "SUB"]} | {"RR": {"mute": False, "eq": None}}}
    m = c.post("/v1/presets/apply", json=solo, headers=H).json()
    assert m["applied"] and m["backup_id"] is None                     # one backup per session
    assert [o["mute"] for o in outputs(app_)] == [0, 0, 0, 1, 0, 0]

    r = c.post("/v1/restore", json={"to": "last-tune"}, headers=H).json()
    assert r["restored"] and r["verified"] and "last tune" in r["what"]
    assert [o["mute"] for o in outputs(app_)] == [1] * 6
    assert outputs(app_)[0]["EQ"][ISO_31.index(1000)]["level"] == 570
    assert len(list((svc.root / "backups").iterdir())) == 1


def test_baseline_capture_and_upload(sim):
    c, app_, _ = sim
    outputs(app_)[1]["hFreq"] = 95                                     # user's tune in the app
    b = c.post("/v1/baseline/capture", headers=H).json()
    assert b["source"] == "captured"
    r = c.post("/v1/presets/compile", json={"channels": {"FL": {"mute": False}}}, headers=H).json()
    p = Preset(json.loads(c.get(r["file"]["url"], headers=H).content))
    assert p.outputs[1]["hFreq"] == 95                                 # patched onto the capture
    assert c.put("/v1/baseline", content=b"{}", headers=H).status_code == 400
    good = Path(DEVICES["EL-PA4.6"]["factory_default"]).read_bytes()
    assert c.put("/v1/baseline", content=good, headers=H).json()["source"] == "uploaded"


def test_manual_mode_returns_file(tmp_path):
    svc = BridgeService(ElPa46Driver(ManualApp("not on Windows")), tmp_path, "real")
    c = TestClient(create_app(svc, TOKEN))
    d = c.get("/v1/device", headers=H).json()
    assert d["status"]["automation"] is False
    a = c.post("/v1/presets/apply", json={"channels": {"RR": {"mute": False}}}, headers=H).json()
    assert a["applied"] is False and a["manual"] and "not on Windows" in a["message"]
    assert c.get(a["file"]["url"], headers=H).status_code == 200
    assert c.post("/v1/baseline/capture", headers=H).status_code == 409


def test_fake_rew_rta_and_match_target(tmp_path):
    car = SimCar()
    app_ = SimDspApp(DEVICES["EL-PA4.6"]["factory_default"])
    rew = TestClient(create_fake_rew(car, app_))
    assert "Save current" in rew.get("/rta/commands").json()
    rew.post("/rta/command", json={"command": "Start"})
    assert rew.get("/rta/levels").json()["averages"] > 0
    rew.post("/rta/command", json={"command": "Stop"})
    rew.post("/rta/command", json={"command": "Save current"})
    ms = rew.get("/measurements").json()
    assert len(ms) == 1
    fr = rew.get(f"/measurements/{ms[0]['uuid']}/frequency-response?ppo=48").json()
    assert fr["ppo"] == 48 and len(fr["magnitude"]) > 100

    house = tmp_path / "house.txt"
    house.write_text("\n".join(f"{f} {0}" for f in (20, 1000, 20000)))
    uid = ms[0]["uuid"]
    assert rew.post("/eq/house-curve", json={"filePath": str(house)}).status_code == 200
    rew.post(f"/measurements/{uid}/target-level", content=b"80")
    rew.post("/eq/match-target-settings", json={"startFrequency": 60, "endFrequency": 16000,
                                                "individualMaxBoostdB": 3})
    assert rew.post(f"/measurements/{uid}/eq/command", json={"command": "Match target"}).status_code == 200
    filt = rew.get(f"/measurements/{uid}/filters").json()
    assert filt and all(set(f) >= {"frequency", "gaindB", "q"} for f in filt)
