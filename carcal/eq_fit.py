"""Fit the DSP's fixed 31-band EQ to a target correction curve.

The EL-PA4.6 stores 31 bands at the ISO 1/3-octave centres. Until we know
whether those centres can be moved (true PEQ), the safe assumption is a
graphic EQ: fixed frequencies, fixed bandwidth, adjustable gain only.

REW's Match Target produces free parametric filters, so we convert:
  1. Compute the response REW wants  (sum of its PEQ filters).
  2. Solve for 31 band gains whose combined response is closest to it,
     only inside the channel's passband.
  3. Quantise to the DSP's gain step, re-simulate, and report the error.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares

from .rew_filters import Filter, log_grid, response_db
from .spec import DEFAULT_SPEC, ISO_31, DeviceSpec


@dataclass
class FitResult:
    gains_db: list[float]          # 31 values, quantised
    freqs: np.ndarray
    target_db: np.ndarray
    achieved_db: np.ndarray
    rms_err_db: float
    max_err_db: float
    f_lo: float
    f_hi: float
    clipped_bands: list[int]       # bands that hit a gain limit

    def report(self) -> str:
        bands = ", ".join(f"{ISO_31[i]}Hz {g:+.1f}" for i, g in enumerate(self.gains_db) if g)
        lines = [f"fit range {self.f_lo:.0f}-{self.f_hi:.0f} Hz  "
                 f"RMS error {self.rms_err_db:.2f} dB  max error {self.max_err_db:.2f} dB",
                 f"bands: {bands or 'all flat'}"]
        if self.clipped_bands:
            lines.append("at gain limit: " + ", ".join(f"{ISO_31[i]}Hz" for i in self.clipped_bands))
        return "\n".join(lines)


def _band_filters(gains: np.ndarray, q: float) -> list[Filter]:
    return [Filter("PK", float(fc), float(g), q) for fc, g in zip(ISO_31, gains)]


def bank_db(gains: np.ndarray, centers: np.ndarray, q: float, freqs: np.ndarray,
            fs: float) -> np.ndarray:
    """dB response of each peaking band separately, shape (bands, freqs). Vectorised RBJ."""
    gains = np.asarray(gains, float)[:, None]
    A = 10 ** (gains / 40)
    w0 = 2 * np.pi * np.asarray(centers, float)[:, None] / fs
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b0, b1, b2 = 1 + alpha * A, -2 * cw, 1 - alpha * A
    a0, a1, a2 = 1 + alpha / A, -2 * cw, 1 - alpha / A
    z = np.exp(-1j * 2 * np.pi * np.asarray(freqs)[None, :] / fs)
    h = (b0 + b1 * z + b2 * z * z) / (a0 + a1 * z + a2 * z * z)
    return 20 * np.log10(np.abs(h))


def smoothing_matrix(freqs: np.ndarray, octave_fraction: np.ndarray) -> np.ndarray:
    """Row-normalised moving average over +-fraction/2 octave around each point (dB domain).

    Linear, so it can sit inside the least-squares residual and Jacobian.
    """
    lf = np.log2(freqs)
    half = np.asarray(octave_fraction, float) / 2
    m = (np.abs(lf[None, :] - lf[:, None]) <= half[:, None]).astype(float)
    return m / m.sum(axis=1, keepdims=True)


def fit_31band(target_db: np.ndarray, freqs: np.ndarray, *, f_lo: float, f_hi: float,
               spec: DeviceSpec = DEFAULT_SPEC, bw_code: int = 14,
               max_boost_db: float = 3.0, max_cut_db: float | None = None,
               perceptual: np.ndarray | None = None, ripple_weight: float = 0.6) -> FitResult:
    """Fit band gains to a correction curve.

    perceptual: per-frequency smoothing width (octaves). When given, the fit
    matches the *smoothed* EQ response to the smoothed correction (what the ear
    integrates, CAT-BUG 6.6) and penalises the ripple between band centres with
    `ripple_weight`. With narrow bands this trades a little broad accuracy for
    much shallower notches.
    """
    if bw_code not in spec.bw_to_q:
        raise ValueError(f"no Q known for bw code {bw_code}")
    q = spec.bw_to_q[bw_code]
    fs = spec.fs
    lo_lim = -abs(max_cut_db) if max_cut_db is not None else spec.eq_gain_min_db
    hi_lim = min(max_boost_db, spec.eq_gain_max_db)

    in_band = (freqs >= f_lo) & (freqs <= f_hi)
    # Bands whose centre sits within ~1/3 oct of the fit range may move; the rest stay flat.
    free = np.array([(f_lo / 1.26) <= fc <= (f_hi * 1.26) for fc in ISO_31])

    centers = np.array(ISO_31, float)[free]
    f_in = freqs[in_band]
    t_in = target_db[in_band]
    reg = 0.02             # small regulariser keeps neighbouring bands from fighting

    if perceptual is not None:
        S = smoothing_matrix(f_in, np.asarray(perceptual)[in_band])
        R = np.eye(len(f_in)) - S              # ripple = response minus its smoothed self
        t_s = S @ t_in

        def resid(x):
            b = bank_db(x, centers, q, f_in, fs).sum(axis=0)
            return np.concatenate([S @ b - t_s, ripple_weight * (R @ b), reg * x])

        def jac(x):
            e = 1e-3
            d = ((bank_db(x + e, centers, q, f_in, fs) - bank_db(x, centers, q, f_in, fs)) / e).T
            return np.vstack([S @ d, ripple_weight * (R @ d), reg * np.eye(len(x))])
    else:
        def resid(x):
            err = bank_db(x, centers, q, f_in, fs).sum(axis=0) - t_in
            return np.concatenate([err, reg * x])

        def jac(x):
            # Each band only moves its own term, so d(total)/d(g_k) = d(band_k)/d(g_k).
            e = 1e-3
            d = (bank_db(x + e, centers, q, f_in, fs) - bank_db(x, centers, q, f_in, fs)) / e
            return np.vstack([d.T, reg * np.eye(len(x))])

    x0 = np.clip(np.interp(centers, freqs, target_db), lo_lim + 1e-6, hi_lim - 1e-6)
    sol = least_squares(resid, x0, jac=jac, bounds=(lo_lim, hi_lim), method="trf")

    step = 1.0 / spec.eq_level_per_db
    g = np.zeros(len(ISO_31))
    g[free] = np.round(sol.x / step) * step
    achieved = response_db(_band_filters(g, q), freqs, fs)
    err = (achieved - target_db)[in_band]
    clipped = [i for i in range(len(ISO_31))
               if free[i] and (g[i] <= lo_lim + 1e-6 or g[i] >= hi_lim - 1e-6) and g[i] != 0]
    return FitResult([round(float(x), 2) for x in g], freqs, target_db, achieved,
                     float(np.sqrt(np.mean(err**2))), float(np.max(np.abs(err))),
                     f_lo, f_hi, clipped)


def fit_from_rew(filters: list[Filter], *, f_lo: float, f_hi: float,
                 spec: DeviceSpec = DEFAULT_SPEC, **kw) -> FitResult:
    freqs = log_grid(20, 20000, 48)
    target = response_db(filters, freqs, spec.fs)
    return fit_31band(target, freqs, f_lo=f_lo, f_hi=f_hi, spec=spec, **kw)
