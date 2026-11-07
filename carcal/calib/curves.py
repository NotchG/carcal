"""Frequency grid, house curves, tone controls, crossover shapes and smoothing."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np

from ..rew_filters import Filter, response_db

# One shared grid: 20 Hz - 20 kHz, 48 points per octave (CAT-BUG measures at 1/48 oct).
PPO = 48
GRID = np.geomspace(20.0, 20000.0, int(math.log2(1000) * PPO) + 1)


def to_grid(freqs, spl) -> np.ndarray:
    """Resample any (freq, dB) data onto GRID by log-frequency interpolation."""
    f = np.asarray(freqs, float)
    s = np.asarray(spl, float)
    order = np.argsort(f)
    f, s = f[order], s[order]
    keep = f > 0
    return np.interp(np.log10(GRID), np.log10(f[keep]), s[keep])


# ---------------- house curves ----------------
# Points are (Hz, dB) relative to 1 kHz, interpolated on log frequency.
# These are carcal's own starting points, not copies of any published curve.
HOUSE_PRESETS: dict[str, dict] = {
    "neutral": {
        "label": "Neutral car",
        "description": "Moderate bass lift, gentle treble roll-off. A safe starting point.",
        "points": [(20, 9), (40, 8.5), (80, 6), (150, 2.5), (300, 0.5), (1000, 0),
                   (3000, -1), (10000, -3.5), (20000, -5)],
    },
    "warm": {
        "label": "Warm",
        "description": "More bass, softer highs. Relaxed for long drives.",
        "points": [(20, 12), (40, 11.5), (80, 8), (150, 4), (300, 1.5), (1000, 0),
                   (3000, -2), (10000, -6), (20000, -8)],
    },
    "detailed": {
        "label": "Detailed",
        "description": "Lighter bass lift, near-flat highs. More upfront vocals and detail.",
        "points": [(20, 6), (60, 5), (120, 2), (300, 0), (1000, 0), (4000, 0),
                   (10000, -1.5), (20000, -3)],
    },
    "flat": {
        "label": "Flat",
        "description": "No shaping. Useful as a reference; usually sounds thin and bright in a car.",
        "points": [(20, 0), (20000, 0)],
    },
}


def points_curve(points: list[tuple[float, float]]) -> np.ndarray:
    pts = sorted((float(f), float(g)) for f, g in points)
    f = np.array([p[0] for p in pts])
    g = np.array([p[1] for p in pts])
    return np.interp(np.log10(GRID), np.log10(f), g)


def parse_curve_text(text: str) -> list[tuple[float, float]]:
    """Read a REW-style house curve / target text file: 'freq dB' per line.

    Accepts comments (* # ;), comma/tab/space separators, and extra columns.
    Jazzi's tuning companion and REW exports both work.
    """
    pts = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "*#;\"'" or line[0].isalpha():
            continue
        nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", line)
        if len(nums) >= 2:
            f, g = float(nums[0]), float(nums[1])
            if 1 <= f <= 100000:
                pts.append((f, g))
    if len(pts) < 2:
        raise ValueError("need at least two 'frequency dB' lines")
    return pts


# ---------------- tone controls ----------------
@dataclass
class Tone:
    bass: float = 0.0      # dB, low shelf
    mid: float = 0.0       # dB, broad peak
    treble: float = 0.0    # dB, high shelf
    bass_hz: float = 100.0
    mid_hz: float = 1000.0
    treble_hz: float = 5000.0

    def response(self) -> np.ndarray:
        fs = 96000      # analog-like shape: high fs keeps the top octave undistorted
        return response_db([
            Filter("LSC", self.bass_hz, self.bass, 0.6),
            Filter("PK", self.mid_hz, self.mid, 0.6),
            Filter("HSC", self.treble_hz, self.treble, 0.6),
        ], GRID, fs)


# ---------------- crossovers ----------------
def lr4_db(hp_hz: float | None = None, lp_hz: float | None = None) -> np.ndarray:
    """Ideal 24 dB/oct Linkwitz-Riley magnitude (CAT-BUG's acoustic target slope)."""
    out = np.zeros_like(GRID)
    if hp_hz:
        out += 20 * np.log10(1 / (1 + (hp_hz / GRID) ** 4))
    if lp_hz:
        out += 20 * np.log10(1 / (1 + (GRID / lp_hz) ** 4))
    return out


# ---------------- smoothing ----------------
def smooth(spl: np.ndarray, octave_fraction: float | np.ndarray) -> np.ndarray:
    """Fractional-octave smoothing in the power domain on GRID.

    octave_fraction can be one value (1/3 -> third-octave) or an array per point
    for variable smoothing.
    """
    p = 10 ** (np.asarray(spl) / 10)
    frac = np.broadcast_to(np.asarray(octave_fraction, float), GRID.shape)
    n = len(GRID)
    csum = np.concatenate([[0.0], np.cumsum(p)])
    half = np.maximum(1, np.round(frac * PPO / 2).astype(int))
    idx = np.arange(n)
    lo = np.maximum(0, idx - half)
    hi = np.minimum(n, idx + half + 1)
    return 10 * np.log10((csum[hi] - csum[lo]) / (hi - lo))


def psycho_fraction(role: str) -> np.ndarray:
    """Per-frequency smoothing width, following CAT-BUG section 6.6:
    1/12 oct for subs, 1/6 for midbass, 1/3 for mids and highs."""
    f = GRID
    if role == "sub":
        return np.full_like(f, 1 / 12)
    frac = np.where(f < 300, 1 / 6, 1 / 3)
    return frac


@dataclass
class Target:
    house: str = "neutral"                                   # preset key, or "custom"
    custom_points: list[tuple[float, float]] = field(default_factory=list)
    tone: Tone = field(default_factory=Tone)

    def house_db(self) -> np.ndarray:
        if self.house == "custom":
            if not self.custom_points:
                raise ValueError("custom house curve selected but no points loaded")
            c = points_curve(self.custom_points)
            return c - np.interp(np.log10(1000), np.log10(GRID), c)   # 0 dB at 1 kHz
        return points_curve(HOUSE_PRESETS[self.house]["points"])

    def system_db(self) -> np.ndarray:
        return self.house_db() + self.tone.response()
