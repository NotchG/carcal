"""A simulated car: DSP + cabin + microphone, for development without the car.

SimCar gives each DSP output a plausible in-cabin response (door midbass
cancellations, cabin gain, off-axis treble loss on rears, a sub that rolls off
on its own). SimDspApp behaves like the Rainbow app (holds a preset; import /
export files). SimRew "measures" whatever the simulated DSP currently plays,
including its EQ and crossovers, so the whole loop - measure, compute, apply,
re-measure - can be exercised end to end.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from ..dsp_codec import Preset
from ..rew_filters import Filter, response_db
from ..spec import ISO_31
from .curves import GRID

ROLE_BY_OUTPUT = {"FL": "front", "FR": "front", "RL": "rear", "RR": "rear",
                  "SUB_L": "sub", "SUB_R": "sub"}


def _bump(f0, gain, q):
    return response_db([Filter("PK", f0, gain, q)], GRID, 96000)


def _hp(fc, order):
    return -10 * np.log10(1 + (fc / GRID) ** (2 * order))


def _lp(fc, order):
    return -10 * np.log10(1 + (GRID / fc) ** (2 * order))


class SimCar:
    def __init__(self, seed: int = 7):
        rng = np.random.default_rng(seed)
        self.base: dict[str, np.ndarray] = {}
        for name, role in ROLE_BY_OUTPUT.items():
            side = 1 if name.endswith("R") else 0
            if role == "front":
                r = 86 + _hp(55, 2) + _bump(48, 4, 3) + _bump(110, 5, 4) \
                    + _bump(260 + 30 * side, -14, 12) + _bump(1500, -4, 2) \
                    + _bump(3200, 5 + side, 3) + _lp(18000, 2)
            elif role == "rear":
                r = 82 + _hp(75, 2) + _bump(130, 4, 3) + _bump(650, -6, 4) \
                    + _bump(5000, -5, 0.6) + _lp(14000, 2)
            else:
                r = 94 + _hp(22, 2) + _lp(140, 2) + _bump(42, 6, 4) + _bump(68, -12, 10)
            ripple = np.convolve(rng.normal(0, 1.4, len(GRID)), np.ones(9) / 9, mode="same")
            self.base[name] = r + ripple + (1.2 if side else 0)      # right side a bit louder
        self.noise = 38 + 12 * np.exp(-GRID / 120) - 4 * np.log10(GRID / 20)
        self.rng = rng

    def output_response(self, p: Preset, name: str) -> np.ndarray | None:
        i = p.channel_map[name]
        o = p.outputs[i]
        if o["mute"] != p.spec.mute_active_value:
            return None
        slope_off = next(k for k, v in p.spec.slope_db_per_oct.items() if v is None)
        r = self.base[name].copy()
        if o["hLevel"] != slope_off:
            r += _hp(o["hFreq"], o["hLevel"] + 1)
        if o["lLevel"] != slope_off:
            r += _lp(o["lFreq"], o["lLevel"] + 1)
        q = p.spec.bw_to_q.get(14, 7.6)
        bands = [Filter("PK", float(fc), p.level_to_db(b["level"]), q)
                 for fc, b in zip(ISO_31, o["EQ"]) if b["level"] != p.spec.eq_level_offset]
        if bands:
            r += response_db(bands, GRID, p.spec.fs)
        r += (o["gain"] - 60) * 0.5          # guessed channel gain step, sim only
        return r

    def measure(self, p: Preset, jitter: float = 0.25) -> np.ndarray:
        """What the mic would read with the given preset playing (moving-mic average)."""
        power = 10 ** (self.noise / 10)
        subs = [r for n in ("SUB_L", "SUB_R") if (r := self.output_response(p, n)) is not None]
        if subs:                                  # both sub outputs drive one sub coherently
            power = power + 10 ** ((max(subs, key=np.mean) + (6 if len(subs) == 2 else 0) - 6) / 10)
        for n in ("FL", "FR", "RL", "RR"):
            r = self.output_response(p, n)
            if r is not None:
                power = power + 10 ** (r / 10)
        return 10 * np.log10(power) + self.rng.normal(0, jitter, len(GRID))


class SimDspApp:
    """Stands in for RainbowApp: holds the app's current preset."""

    def __init__(self, start: str | Path):
        self.state = json.loads(Path(start).read_bytes())
        self.selected = 1

    def preset(self) -> Preset:
        from ..dsp_codec import dumps
        return Preset(json.loads(dumps(self.state)))

    def status(self) -> dict:
        return {"window_found": True, "connected": True, "simulated": True}

    def screenshot(self):
        return Image.new("RGB", (800, 480), (18, 28, 52))

    def import_preset(self, path) -> list[str]:
        self.state = json.loads(Path(path).read_bytes())
        return []

    def export_preset(self, path) -> list[str]:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(json.dumps(self.state, separators=(",", ":")).encode())
        return []

    def select_channel(self, n: int) -> str:
        self.selected = n
        return "sim"


class SimRew:
    """Stands in for REW's API: RTA start/stop and capture of the simulated mic."""

    def __init__(self, car: SimCar, dsp: SimDspApp):
        self.car, self.dsp = car, dsp
        self.running = False
        self.pink_noise_on = True       # flip off to measure the noise floor

    def status(self) -> dict:
        return {"connected": True, "simulated": True}

    def rta_start(self) -> None:
        self.running = True

    def rta_live(self) -> dict:
        spl = self._read()
        return {"freqs": GRID.round(2).tolist(), "spl": spl.round(2).tolist(),
                "averages": 100 if self.running else 0}

    def rta_stop_and_fetch(self, name: str) -> tuple[list[float], list[float], dict]:
        self.running = False
        return GRID.tolist(), self._read().tolist(), {"source": "sim", "averages": 100}

    def pull_latest(self) -> tuple[list[float], list[float], dict]:
        return GRID.tolist(), self._read().tolist(), {"source": "sim"}

    def _read(self) -> np.ndarray:
        if not self.pink_noise_on:
            return self.car.noise + self.car.rng.normal(0, 0.5, len(GRID))
        return self.car.measure(self.dsp.preset())
