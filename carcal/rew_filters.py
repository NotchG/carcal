"""Parse REW EQ filter exports and compute their frequency response.

Accepts
  * REW's "Export filter settings as text" file (any REW 5.x layout), e.g.
        Filter  1: ON  PK       Fc   63.00 Hz  Gain  -6.50 dB  Q  4.200
        Filter  2: ON  LSC      Fc   105.0 Hz  Gain   3.00 dB  Q  0.707
        Filter  3: OFF None
  * a list of dicts (e.g. filters read back from the REW API), with tolerant keys:
        {"type": "PK", "enabled": true, "frequency": 63, "gaindB": -6.5, "q": 4.2}
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SUPPORTED = {"PK", "LS", "HS", "LSC", "HSC", "LSQ", "HSQ"}


@dataclass
class Filter:
    type: str            # PK, LS, HS, LSC, HSC ...
    fc: float            # Hz
    gain_db: float
    q: float | None = None
    enabled: bool = True
    index: int | None = None

    def __str__(self) -> str:
        q = f" Q {self.q:.2f}" if self.q else ""
        return f"{self.type:4} {self.fc:8.1f} Hz {self.gain_db:+6.2f} dB{q}"


def _bw_oct_to_q(n: float) -> float:
    return math.sqrt(2 ** n) / (2 ** n - 1)


_LINE = re.compile(r"^\s*Filter\s+(\d+)\s*:\s*(ON|OFF)\s+(\S+)(.*)$", re.I)
_FC = re.compile(r"Fc\s+(-?[\d.]+)\s*(k?)Hz", re.I)
_GAIN = re.compile(r"Gain\s+(-?[\d.]+)\s*dB", re.I)
_Q = re.compile(r"\bQ\s+([\d.]+)", re.I)
_BW = re.compile(r"BW\s*Oct\s+([\d.]+)", re.I)


def parse_text(text: str) -> list[Filter]:
    filters: list[Filter] = []
    for line in text.splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        idx, state, ftype, rest = int(m.group(1)), m.group(2).upper(), m.group(3).upper(), m.group(4)
        if ftype in ("NONE", "NO") or state == "OFF":
            continue
        fc_m, g_m = _FC.search(rest), _GAIN.search(rest)
        if not fc_m:
            continue
        fc = float(fc_m.group(1)) * (1000 if fc_m.group(2) else 1)
        gain = float(g_m.group(1)) if g_m else 0.0
        q = None
        if (q_m := _Q.search(rest)):
            q = float(q_m.group(1))
        elif (bw_m := _BW.search(rest)):
            q = _bw_oct_to_q(float(bw_m.group(1)))
        if ftype not in SUPPORTED:
            raise ValueError(f"filter {idx}: type {ftype} not supported by the 31-band "
                             f"conversion (line: {line.strip()!r})")
        filters.append(Filter(ftype, fc, gain, q, True, idx))
    return filters


def parse_file(path: str | Path) -> list[Filter]:
    return parse_text(Path(path).read_text(encoding="utf-8", errors="replace"))


def from_dicts(items: list[dict]) -> list[Filter]:
    def pick(d, *keys, default=None):
        for k in keys:
            if k in d:
                return d[k]
        return default
    out = []
    for d in items:
        if not pick(d, "enabled", "isEnabled", default=True):
            continue
        t = str(pick(d, "type", "filterType", default="PK")).upper()
        if t in ("NONE", "NO"):
            continue
        out.append(Filter(t, float(pick(d, "frequency", "fc", "freq")),
                          float(pick(d, "gaindB", "gain", "gainDb", default=0.0)),
                          pick(d, "q", "Q"), True, pick(d, "index")))
    return out


# ---------------- frequency response (RBJ audio-EQ cookbook) ----------------

def _biquad(f: Filter, fs: float) -> tuple[np.ndarray, np.ndarray]:
    A = 10 ** (f.gain_db / 40)
    w0 = 2 * math.pi * f.fc / fs
    cw, sw = math.cos(w0), math.sin(w0)
    t = f.type
    if t == "PK":
        q = f.q or 1.0
        alpha = sw / (2 * q)
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif t in ("LS", "LSC", "LSQ", "HS", "HSC", "HSQ"):
        q = f.q or (1 / math.sqrt(2))
        alpha = sw / (2 * q)
        sa = 2 * math.sqrt(A) * alpha
        if t.startswith("L"):
            b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw),
                 A * ((A + 1) - (A - 1) * cw - sa)]
            a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw),
                 (A + 1) + (A - 1) * cw - sa]
        else:
            b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw),
                 A * ((A + 1) + (A - 1) * cw - sa)]
            a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw),
                 (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(f"unsupported filter type {t}")
    return np.array(b) / a[0], np.array(a) / a[0]


def response_db(filters: list[Filter], freqs: np.ndarray, fs: float = 48000) -> np.ndarray:
    """Summed magnitude response (dB) of a filter chain at `freqs`."""
    z = np.exp(-1j * 2 * np.pi * np.asarray(freqs) / fs)
    total = np.zeros(len(freqs))
    for f in filters:
        if not f.enabled or f.gain_db == 0:
            continue
        b, a = _biquad(f, fs)
        h = (b[0] + b[1] * z + b[2] * z**2) / (a[0] + a[1] * z + a[2] * z**2)
        total += 20 * np.log10(np.abs(h))
    return total


def log_grid(f_lo: float = 20, f_hi: float = 20000, points_per_oct: int = 48) -> np.ndarray:
    n = int(math.log2(f_hi / f_lo) * points_per_oct) + 1
    return np.geomspace(f_lo, f_hi, n)
