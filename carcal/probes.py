"""Probe presets that calibrate the converter against the DSP app.

Each probe starts from a clean default and writes known raw values into
specific fields, one value per channel. You import the probe into the app,
read what the app displays, and re-export it. That gives two answers:

  * what the app *shows* for a raw value   -> the unit conversion
  * what the app *saves back*              -> clamping / rounding / valid range

The table below is the single source of truth: it builds the probe files and
the checklist, and the tests check each file changes only these fields.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .dsp_codec import Preset

B1K = 17   # EQ index of the 1 kHz band
B63 = 5    # EQ index of the 63 Hz band


@dataclass
class Setting:
    channel: str
    field: str            # output field, or "EQ[i].key"
    raw: int
    note: str = ""


@dataclass
class Probe:
    id: str
    title: str
    ask: str              # what to read in the app
    settings: list[Setting]
    caution: str = ""


PROBES: list[Probe] = [
    Probe("01", "EQ gain step", "the dB value on each channel's 1 kHz band", [
        Setting("FL", f"EQ[{B1K}].level", 570),
        Setting("FR", f"EQ[{B1K}].level", 630),
        Setting("RL", f"EQ[{B1K}].level", 590),
        Setting("RR", f"EQ[{B1K}].level", 615),
        Setting("SUB_L", f"EQ[{B1K}].level", 540),
        Setting("SUB_R", f"EQ[{B1K}].level", 660),
    ]),
    Probe("02", "EQ gain range", "the dB value on each 1 kHz band, and whether the app "
          "complained or capped it", [
        Setting("FL", f"EQ[{B1K}].level", 480, "−12 dB?"),
        Setting("FR", f"EQ[{B1K}].level", 720, "+12 dB?"),
        Setting("RL", f"EQ[{B1K}].level", 360, "−24 dB?"),
        Setting("RR", f"EQ[{B1K}].level", 840, "+24 dB?"),
        Setting("SUB_L", f"EQ[{B1K}].level", 0, "far below range"),
        Setting("SUB_R", f"EQ[{B1K}].level", 1200, "far above range"),
    ], caution="Contains extreme boosts. Keep the head unit at volume 0 for this one."),
    Probe("03", "EQ bandwidth codes", "the Q (or bandwidth) shown on each 1 kHz band. "
          "Each band is boosted +6 dB so the width is visible on the curve", [
        Setting("FL", f"EQ[{B1K}].bw", 0), Setting("FL", f"EQ[{B1K}].level", 660),
        Setting("FR", f"EQ[{B1K}].bw", 5), Setting("FR", f"EQ[{B1K}].level", 660),
        Setting("RL", f"EQ[{B1K}].bw", 10), Setting("RL", f"EQ[{B1K}].level", 660),
        Setting("RR", f"EQ[{B1K}].bw", 20), Setting("RR", f"EQ[{B1K}].level", 660),
        Setting("SUB_L", f"EQ[{B1K}].bw", 27), Setting("SUB_L", f"EQ[{B1K}].level", 660),
        Setting("SUB_R", f"EQ[{B1K}].bw", 40), Setting("SUB_R", f"EQ[{B1K}].level", 660),
    ]),
    Probe("04", "Band frequency and type", "the frequency, filter type and any shelf "
          "setting shown on the changed band", [
        Setting("FL", f"EQ[{B1K}].freq", 1100, "moved 1 kHz band"),
        Setting("FL", f"EQ[{B1K}].level", 660),
        Setting("FR", f"EQ[{B1K}].type", 1), Setting("FR", f"EQ[{B1K}].level", 660),
        Setting("RL", f"EQ[{B1K}].type", 2), Setting("RL", f"EQ[{B1K}].level", 660),
        Setting("RR", f"EQ[{B1K}].shfDb", 6), Setting("RR", f"EQ[{B1K}].level", 660),
        Setting("SUB_L", f"EQ[{B63}].freq", 55, "moved 63 Hz band"),
        Setting("SUB_L", f"EQ[{B63}].level", 660),
        Setting("SUB_R", f"EQ[{B1K}].type", 3), Setting("SUB_R", f"EQ[{B1K}].level", 660),
    ]),
    Probe("05", "Delay unit", "the delay shown for each channel, in ms AND cm if the "
          "app shows both", [
        Setting("FL", "delay", 1),
        Setting("FR", "delay", 48),
        Setting("RL", "delay", 100),
        Setting("RR", "delay", 480),
        Setting("SUB_L", "delay", 1000),
        Setting("SUB_R", "delay", 0, "control (unchanged)"),
    ]),
    Probe("06", "Channel gain unit", "the output level/gain shown for each channel", [
        Setting("FL", "gain", 60, "control (unchanged)"),
        Setting("FR", "gain", 59),
        Setting("RL", "gain", 50),
        Setting("RR", "gain", 40),
        Setting("SUB_L", "gain", 30),
        Setting("SUB_R", "gain", 0),
    ]),
    Probe("07", "Mute and polarity", "which channels show muted, which show phase "
          "inverted (180°), and anything else that looks changed", [
        Setting("FL", "mute", 0),
        Setting("FR", "polar", 1),
        Setting("RL", "polarS", 1, "unknown field"),
        Setting("RR", "mute", 0), Setting("RR", "polar", 1),
        Setting("SUB_R", "polar", 1),
    ]),
    Probe("08", "Crossover type and slope codes", "the high-pass (FL, FR, RL, RR) or "
          "low-pass (subs) filter type and slope shown", [
        Setting("FL", "hFreq", 100), Setting("FL", "hFilter", 0), Setting("FL", "hLevel", 0),
        Setting("FR", "hFreq", 100), Setting("FR", "hFilter", 1), Setting("FR", "hLevel", 1),
        Setting("RL", "hFreq", 100), Setting("RL", "hFilter", 2, "control: default type"),
        Setting("RL", "hLevel", 2),
        Setting("RR", "hFreq", 100), Setting("RR", "hFilter", 0), Setting("RR", "hLevel", 5),
        Setting("SUB_L", "lFreq", 80), Setting("SUB_L", "lFilter", 1), Setting("SUB_L", "lLevel", 7),
        Setting("SUB_R", "lFreq", 80), Setting("SUB_R", "lFilter", 0), Setting("SUB_R", "lLevel", 8),
    ]),
    Probe("09", "All-pass filter", "the all-pass mode/order, frequency and Q shown "
          "on each channel", [
        Setting("FL", "AllPassType", 1), Setting("FL", "AllPassHz", 100),
        Setting("FR", "AllPassType", 1), Setting("FR", "AllPassHz", 100),
        Setting("FR", "AllPassQ", 10),
        Setting("RL", "AllPassType", 2), Setting("RL", "AllPassHz", 500),
        Setting("RR", "AllPassType", 1), Setting("RR", "AllPassHz", 1000),
        Setting("RR", "AllPassQ", 1),
    ]),
]


def apply(base: Preset, probe: Probe) -> Preset:
    p = base.copy()
    for s in probe.settings:
        if s.field.startswith("EQ["):
            band = int(s.field[3:s.field.index("]")])
            key = s.field.split(".", 1)[1]
            p.set_band_raw(s.channel, band, **{key: s.raw})
        else:
            p.set_raw(s.channel, s.field, s.raw)
    return p


def _baseline_value(base: Preset, s: Setting) -> int:
    (i,) = base.resolve(s.channel)
    o = base.outputs[i]
    if s.field.startswith("EQ["):
        band = int(s.field[3:s.field.index("]")])
        return o["EQ"][band][s.field.split(".", 1)[1]]
    return o[s.field]


def checklist(base: Preset) -> str:
    lines = [
        "# Converter calibration — probe checklist",
        "",
        "## Before you start",
        "- Head unit volume at **0** (probe 02 has extreme boosts). Nothing needs to play.",
        "- Keep `clean_default.dspSingle` handy; you import it again at the end.",
        "",
        "## For each probe",
        "1. Import `probe_NN.dspSingle` into the app.",
        "2. Write down what the app shows (the **App shows** column). A photo or screenshot works too.",
        "3. Export it straight back, unchanged, as `probe_NN_back.dspSingle`.",
        "4. If the app refuses the file or crashes, note that and move on.",
        "",
        "When done: import `clean_default.dspSingle` again, then send me the notes "
        "and all the `_back` files.",
        "",
    ]
    for pr in PROBES:
        lines += [f"## Probe {pr.id} — {pr.title}", "", f"**Read:** {pr.ask}.", ""]
        if pr.caution:
            lines += [f"> ⚠️ {pr.caution}", ""]
        lines += ["| Channel | Field | Default → probe raw | App shows |", "|---|---|---|---|"]
        for s in pr.settings:
            note = f" ({s.note})" if s.note else ""
            lines.append(f"| {s.channel} | `{s.field}` | {_baseline_value(base, s)} → "
                         f"**{s.raw}**{note} | |")
        lines.append("")
    return "\n".join(lines)


def write_all(base: Preset, outdir: str | Path) -> list[Path]:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    paths = []
    for pr in PROBES:
        path = outdir / f"probe_{pr.id}.dspSingle"
        apply(base, pr).save(path)
        paths.append(path)
    (outdir / "PROBE_CHECKLIST.md").write_text(checklist(base), encoding="utf-8")
    paths.append(outdir / "PROBE_CHECKLIST.md")
    return paths
