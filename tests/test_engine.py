"""Reference engine (Python) closed loop on the simulated car.

The TypeScript engine in the dashboard is checked against this engine's
output (web/lib/engine/__fixtures__/golden.json, see tests/make_golden.py).
"""

import warnings

import numpy as np

from carcal.calib.curves import GRID, Target, Tone, psycho_fraction, smooth
from carcal.calib.engine import ChannelDef, Settings, build_preset, compute_all, measurement_preset
from carcal.calib.sim import SimCar, SimDspApp
from carcal.devices import DEVICES
from carcal.dsp_codec import Preset

warnings.simplefilter("ignore")
CH = [ChannelDef(**{k: v for k, v in c.items()}) for c in DEVICES["EL-PA4.6"]["default_channels"]]


def measure_all(car, base):
    dsp = SimDspApp(DEVICES["EL-PA4.6"]["factory_default"])
    out = {}
    for c in CH:
        dsp.state = measurement_preset(base, CH, c.key).data
        out[c.key] = car.measure(dsp.preset())
    return out


def test_tuning_brings_each_speaker_to_target():
    car = SimCar()
    base = Preset.load(DEVICES["EL-PA4.6"]["factory_default"])
    meas = measure_all(car, base)
    res = compute_all(CH, meas, Target("neutral", [], Tone()), Settings())
    tuned, _ = build_preset(base, CH, res)
    for c in CH:
        r = res["channels"][c.key]
        after = smooth(car.measure(tuned.solo(c.outputs, flatten_eq=False)), psycho_fraction(c.role))
        tgt, before, pred = np.array(r["target"]), np.array(r["measured"]), np.array(r["predicted"])
        pb = (GRID >= (c.hp_hz or 20)) & (GRID <= min(c.lp_hz or 16000, 16000))
        rms = lambda a: float(np.sqrt(np.mean(a[pb] ** 2)))
        assert rms(after - pred) < 0.5, c.key                       # predictions are faithful
        assert rms(after - tgt) < (0.7 if c.key == "SUB" else 0.6) * rms(before - tgt), c.key


def test_system_lines_are_comparable_and_dips_are_explained():
    car = SimCar()
    base = Preset.load(DEVICES["EL-PA4.6"]["factory_default"])
    res = compute_all(CH, measure_all(car, base), Target(), Settings())
    gap = np.array(res["system_estimate"]) - np.array(res["system_target"])
    assert abs(float(np.mean(gap[(GRID > 200) & (GRID < 10000)]))) < 0.5
    notes = " ".join(n for r in res["channels"].values() for n in r["notes"])
    assert "Narrow dip at 68 Hz" in notes                            # the sim sub's cancellation
