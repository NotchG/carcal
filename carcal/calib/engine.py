"""Per-channel EQ from stored measurements, following CAT-BUG.

For each channel (a driver, or a group of DSP outputs playing one driver):

1. Smooth the measurement psychoacoustically (CAT-BUG 6.6).
2. Its individual target = system target (house curve + tone) + ideal LR4 slopes
   at the channel's crossover points (CAT-BUG 5.3.8).
3. Place the target level so the EQ is mostly cuts with a little boost (6.5).
   Left/right pairs share one level, the quieter side's (7, level matching).
4. Correction = target - measurement, from one octave below the HPF to one octave
   above the LPF (6.5). Boosts are only taken where the dip is broad: narrow,
   deep dips are cancellations and are left alone (6.4).
5. Fit the DSP's 31 fixed bands to the correction and predict the result.

Because measurements are stored, changing the house curve or the tone controls
only re-runs these steps: no re-measuring.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from ..dsp_codec import Preset
from ..eq_fit import fit_31band
from ..rew_filters import Filter, response_db
from ..spec import DEFAULT_SPEC, ISO_31, DeviceSpec
from .curves import GRID, Target, lr4_db, psycho_fraction, smooth

SPEED_OF_SOUND_CM_PER_MS = 34.3


@dataclass
class ChannelDef:
    key: str                          # "FL", "SUB", ...
    label: str
    outputs: list[str]                # DSP channel names this driver is wired to
    role: str = "front"               # front | rear | sub
    hp_hz: float | None = None        # crossover points (electrical = acoustic target here)
    lp_hz: float | None = None
    level_offset_db: float = 0.0      # e.g. rear fill a few dB under the fronts
    pair: str | None = None           # mirror channel for left/right level matching
    distance_cm: float | None = None  # head centre to voice coil, for time alignment


@dataclass
class Settings:
    max_boost_db: float = 3.0         # CAT-BUG allows up to 6; 3 is gentler on narrow bands
    max_cut_db: float = 12.0
    boost_share: float = 0.35         # share of the passband allowed to sit below target
    max_fit_error_db: float = 2.0


@dataclass
class ChannelResult:
    key: str
    eq_gains_db: list[float]
    f_lo: float
    f_hi: float
    level_db: float
    natural_level_db: float
    deficit_db: float
    rms_error_db: float
    max_error_db: float
    measured: list[float]
    target: list[float]
    predicted: list[float]
    eq_curve: list[float]
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _range(ch: ChannelDef) -> tuple[float, float]:
    lo = (ch.hp_hz / 2) if ch.hp_hz else 20.0
    hi = (ch.lp_hz * 2) if ch.lp_hz else 20000.0
    return max(20.0, lo), min(20000.0, hi)


def _passband(ch: ChannelDef) -> np.ndarray:
    lo = ch.hp_hz or 20.0
    hi = ch.lp_hz or 20000.0
    if ch.role != "sub":
        hi = min(hi, 16000.0)          # mic + cabin data above 16k are unreliable
    return (GRID >= lo) & (GRID <= hi)


def _narrow_dips(measured: np.ndarray, rng_mask: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """Find deep, narrow dips (cancellations, CAT-BUG 6.4): spots where a lightly
    smoothed trace (1/24 oct) falls well below a broad average (1/2 oct).
    Returns a mask covering each dip and its shoulders, and a note per dip."""
    light = smooth(measured, 1 / 24)
    broad = smooth(measured, 1 / 2)
    core = ((broad - light) > 5) & rng_mask
    mask = core.copy()
    for shift in range(1, 5):                        # widen by ~1/12 oct each side
        mask[shift:] |= core[:-shift]
        mask[:-shift] |= core[shift:]
    notes, i = [], 0
    while i < len(GRID):
        if core[i]:
            j = i
            while j + 1 < len(GRID) and core[j + 1]:
                j += 1
            k = i + int(np.argmin(light[i:j + 1]))
            notes.append(f"Narrow dip at {GRID[k]:.0f} Hz left alone (a cancellation: "
                         f"boosting it wastes power)")
            i = j + 1
        else:
            i += 1
    return mask, notes[:4]


def natural_level(ch: ChannelDef, measured: np.ndarray, target: Target,
                  settings: Settings) -> float:
    """Target level at which `boost_share` of the passband would need boosting."""
    shape = target.system_db() + lr4_db(ch.hp_hz, ch.lp_hz)
    m = smooth(measured, 1 / 2)
    pb = _passband(ch)
    return float(np.percentile((m - shape)[pb], settings.boost_share * 100))


def compute_channel(ch: ChannelDef, measured: np.ndarray, target: Target, level_db: float,
                    settings: Settings, spec: DeviceSpec = DEFAULT_SPEC,
                    noise: np.ndarray | None = None) -> ChannelResult:
    notes: list[str] = []
    shape = target.system_db() + lr4_db(ch.hp_hz, ch.lp_hz)
    tgt = shape + level_db
    m_fine = smooth(measured, psycho_fraction(ch.role))
    m_coarse = smooth(measured, 1 / 2)
    f_lo, f_hi = _range(ch)
    rng = (GRID >= f_lo) & (GRID <= f_hi)

    corr_fine = tgt - m_fine
    corr_coarse = tgt - m_coarse
    dips, dip_notes = _narrow_dips(measured, rng)
    corr = np.where(corr_fine > 0, np.minimum(corr_fine, corr_coarse), corr_fine)
    corr = np.where(dips, np.minimum(corr, 0.0), corr)      # never boost into a cancellation
    corr = np.clip(corr, -settings.max_cut_db, settings.max_boost_db)
    corr = np.where(rng, corr, 0.0)
    notes += dip_notes

    frac = psycho_fraction(ch.role)
    fit = fit_31band(corr, GRID, f_lo=f_lo, f_hi=f_hi, spec=spec,
                     max_boost_db=settings.max_boost_db, max_cut_db=settings.max_cut_db,
                     perceptual=frac)
    # What you'd hear: raw measurement + EQ, smoothed like hearing (CAT-BUG 6.6).
    # The raw EQ curve (with its ripple between narrow bands) is returned separately.
    predicted = smooth(measured + fit.achieved_db, frac)
    pb = _passband(ch)
    err = (predicted - tgt)[pb]
    max_err = float(np.max(np.abs(err)))
    # Explain the biggest remaining miss by its cause, skipping narrow dips that
    # were left alone on purpose (they already have their own note).
    left_alone = dips[pb]
    e_rest = np.where(left_alone, 0.0, err)
    k = int(np.argmax(np.abs(e_rest)))
    if abs(e_rest[k]) > settings.max_fit_error_db:
        f_k, miss = GRID[pb][k], float(e_rest[k])
        wanted = float((tgt - m_fine)[pb][k])
        if miss < 0 and wanted > settings.max_boost_db:
            notes.append(f"{-miss:.1f} dB under target around {f_k:.0f} Hz: it would need more "
                         f"than the {settings.max_boost_db:g} dB boost limit (EQ limits)")
        elif miss > 0:
            notes.append(f"{miss:.1f} dB over target around {f_k:.0f} Hz: the DSP's narrow bands "
                         f"(Q 7.6) can't cut that broad an area cleanly")
        else:
            notes.append(f"{-miss:.1f} dB under target around {f_k:.0f} Hz")

    if noise is not None:
        snr = float(np.median((measured - noise)[pb]))
        if snr < 20:
            notes.append(f"Measurement only {snr:.0f} dB above the noise floor "
                         f"(CAT-BUG asks for 20+). Re-measure louder if results look odd.")

    return ChannelResult(
        key=ch.key, eq_gains_db=fit.gains_db, f_lo=f_lo, f_hi=f_hi,
        level_db=level_db, natural_level_db=0.0, deficit_db=0.0,
        rms_error_db=float(np.sqrt(np.mean(err ** 2))), max_error_db=max_err,
        measured=m_fine.round(2).tolist(), target=tgt.round(2).tolist(),
        predicted=predicted.round(2).tolist(), eq_curve=fit.achieved_db.round(2).tolist(),
        notes=notes)


def compute_all(channels: list[ChannelDef], measurements: dict[str, np.ndarray], target: Target,
                settings: Settings = Settings(), spec: DeviceSpec = DEFAULT_SPEC,
                noise: np.ndarray | None = None) -> dict:
    """EQ for every measured channel, with system-wide level alignment."""
    measured = [c for c in channels if c.key in measurements]
    nat = {c.key: natural_level(c, measurements[c.key], target, settings) for c in measured}

    # Reference level: the front pair (or whatever is measured first), quieter side.
    fronts = [c for c in measured if c.role == "front"] or measured[:1]
    ref = min(nat[c.key] for c in fronts) if fronts else 0.0

    results: dict[str, ChannelResult] = {}
    for c in measured:
        want = ref + c.level_offset_db                     # pairs share ref + same offset
        # A channel can't be pulled up further than the boost limit allows.
        reachable = nat[c.key] + settings.max_boost_db * 0.5
        deficit = max(0.0, want - reachable)
        level = want - deficit
        r = compute_channel(c, measurements[c.key], target, level, settings, spec, noise)
        r.natural_level_db = nat[c.key]
        r.deficit_db = round(deficit, 1)
        if deficit > 0.5:
            r.notes.append(f"{deficit:.1f} dB quieter than the target balance. EQ can't make "
                           f"that up: raise this channel's level/amp gain by about "
                           f"{deficit:.0f} dB, then re-measure.")
        results[c.key] = r

    # Left/right pairs: if one side was limited, bring its partner down to match.
    for c in measured:
        if c.pair and c.pair in results and results[c.pair].deficit_db > results[c.key].deficit_db:
            drop = results[c.pair].deficit_db - results[c.key].deficit_db
            r = compute_channel(c, measurements[c.key], target, results[c.key].level_db - drop,
                                settings, spec, noise)
            r.natural_level_db, r.deficit_db = nat[c.key], results[c.key].deficit_db
            r.notes.append(f"Lowered {drop:.1f} dB to stay level-matched with {c.pair}")
            results[c.key] = r

    # Whole system, approximately: power sum of every channel's predicted response,
    # compared with the power sum of every channel's target (same basis, so the two
    # lines are comparable). Phase is ignored, so treat it as a guide.
    def psum(arrays):
        return (10 * np.log10(sum(10 ** (np.asarray(a) / 10) for a in arrays))).round(2).tolist()
    system = psum([r.predicted for r in results.values()]) if results else []
    sys_target = psum([r.target for r in results.values()]) if results else []
    return {
        "freqs": GRID.round(2).tolist(),
        "system_target": sys_target,
        "system_estimate": system,
        "reference_level_db": round(ref, 2),
        "channels": {k: v.to_dict() for k, v in results.items()},
        "delays_ms": delays_ms(measured),
    }


def delays_ms(channels: list[ChannelDef]) -> dict[str, float]:
    """Tape-measure time alignment (CAT-BUG 9.2): delay every driver to the farthest."""
    d = {c.key: c.distance_cm for c in channels if c.distance_cm}
    if not d:
        return {}
    far = max(d.values())
    return {k: round((far - v) / SPEED_OF_SOUND_CM_PER_MS, 3) for k, v in d.items()}


# ---------------- presets ----------------
def apply_crossovers(p: Preset, channels: list[ChannelDef]) -> None:
    """Write each channel's crossover points into its outputs (frequency only; the
    filter type and slope already in the preset are kept, and an output whose
    filter was OFF is switched to 24 dB/oct)."""
    off = next(k for k, v in p.spec.slope_db_per_oct.items() if v is None)
    for c in channels:
        for i in p.resolve(c.outputs):
            o = p.outputs[i]
            if c.hp_hz:
                o["hFreq"] = int(round(c.hp_hz))
                if o["hLevel"] == off:
                    o["hLevel"] = 3
            else:
                o["hFreq"], o["hLevel"] = 20, off
            if c.lp_hz:
                o["lFreq"] = int(round(c.lp_hz))
                if o["lLevel"] == off:
                    o["lLevel"] = 3
            else:
                o["lFreq"], o["lLevel"] = 20000, off


def measurement_preset(baseline: Preset, channels: list[ChannelDef], key: str) -> Preset:
    """Only `key` playing, EQ flat, the profile's crossovers in place."""
    p = baseline.copy()
    apply_crossovers(p, channels)
    ch = next(c for c in channels if c.key == key)
    return p.solo(ch.outputs, flatten_eq=True, keep_crossovers=True)


def build_preset(baseline: Preset, channels: list[ChannelDef], computed: dict) -> tuple[Preset, list[str]]:
    """Baseline + crossovers + computed EQ on every measured channel, all playing."""
    notes: list[str] = []
    p = baseline.copy()
    apply_crossovers(p, channels)
    for c in channels:
        idx = p.resolve(c.outputs)
        p.set_mute(idx, muted=False)
        res = computed["channels"].get(c.key)
        if res is None:
            p.flatten_eq(idx)
            notes.append(f"{c.key}: not measured, EQ left flat")
            continue
        p.set_eq_gains(idx, res["eq_gains_db"])
    if computed.get("delays_ms"):
        if p.spec.delay_status == "unknown":
            notes.append("Delays calculated but not written (the DSP's delay unit isn't "
                         "confirmed yet). Type them in the app: " +
                         ", ".join(f"{k} {v:.3f} ms" for k, v in computed["delays_ms"].items()))
        else:
            for c in channels:
                if c.key in computed["delays_ms"]:
                    p.set_delay_ms(c.outputs, computed["delays_ms"][c.key])
    return p, notes
