"""Write golden data for the TypeScript engine: inputs + the Python reference engine's outputs.

    python tests/make_golden.py   ->  web/lib/engine/__fixtures__/golden.json
"""

import json
import warnings
from pathlib import Path

import numpy as np

from carcal.calib.curves import GRID, Target, Tone
from carcal.calib.engine import ChannelDef, Settings, compute_all, measurement_preset
from carcal.calib.sim import SimCar, SimDspApp
from carcal.devices import DEVICES
from carcal.dsp_codec import Preset

warnings.simplefilter("ignore")
OUT = Path(__file__).parent.parent / "web" / "lib" / "engine" / "__fixtures__" / "golden.json"
R = lambda a: np.round(np.asarray(a, float), 3).tolist()


def channels(distances=None):
    out = []
    for c in DEVICES["EL-PA4.6"]["default_channels"]:
        d = dict(c, distance_cm=(distances or {}).get(c["key"]))
        out.append(d)
    return out


def scenario(name, target, settings, chans, seed=7):
    car = SimCar(seed)
    base = Preset.load(DEVICES["EL-PA4.6"]["factory_default"])
    defs = [ChannelDef(**c) for c in chans]
    dsp = SimDspApp(DEVICES["EL-PA4.6"]["factory_default"])
    meas = {}
    for c in defs:
        dsp.state = measurement_preset(base, defs, c.key).data
        meas[c.key] = car.measure(dsp.preset())
    noise = car.noise + car.rng.normal(0, 0.5, len(GRID))
    res = compute_all(defs, meas, target, settings, noise=noise)
    return {
        "name": name,
        "input": {
            "channels": chans,
            "measurements": {k: R(v) for k, v in meas.items()},
            "noise": R(noise),
            "target": {"house": target.house, "custom_points": target.custom_points,
                       "tone": {"bass": target.tone.bass, "mid": target.tone.mid,
                                "treble": target.tone.treble}},
            "settings": {"max_boost_db": settings.max_boost_db, "max_cut_db": settings.max_cut_db},
        },
        "output": {
            "system_target": res["system_target"],
            "system_estimate": res["system_estimate"],
            "delays_ms": res["delays_ms"],
            "channels": {k: {"eq_gains_db": v["eq_gains_db"], "level_db": round(v["level_db"], 3),
                             "deficit_db": v["deficit_db"], "rms_error_db": round(v["rms_error_db"], 3),
                             "target": v["target"], "predicted": v["predicted"],
                             "measured": v["measured"], "notes": v["notes"]}
                         for k, v in res["channels"].items()},
        },
    }


def main():
    data = {
        "grid": R(GRID),
        "scenarios": [
            scenario("neutral", Target("neutral", [], Tone()), Settings(), channels()),
            scenario("warm_tone_distances", Target("warm", [], Tone(bass=2, mid=-1, treble=-2)),
                     Settings(max_boost_db=4.5),
                     channels({"FL": 120, "FR": 75, "RL": 150, "RR": 125, "SUB": 190}), seed=11),
            scenario("custom_curve", Target("custom", [(20, 10), (100, 6), (1000, 0), (20000, -6)], Tone(treble=1.5)),
                     Settings(max_boost_db=2), channels(), seed=3),
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
