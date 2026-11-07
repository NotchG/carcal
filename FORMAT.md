# EL-PA4.6 `.dspSingle` preset format

Decoded from `wuling.dspSingle` (device `EL-PA4.6`, firmware `DSP-680-31EQ-V3.0`).

**Status key:** ✅ confirmed from the file structure · ⚠️ assumed, needs a test export · ❓ unknown

## File

| Property | Value | Status |
|---|---|---|
| Encoding | UTF-8 JSON, no BOM, no trailing newline | ✅ |
| Layout | Compact (`,` and `:` with no spaces), fixed key order | ✅ re-serialising gives a byte-identical file |
| Checksum | None found | ✅ |
| Top-level | `info`, `system`, `outPuts.outPut[6]` | ✅ |

## Outputs (`outPuts.outPut[0..5]`)

### Channel map (inferred)

| Index | Name | Evidence |
|---|---|---|
| 0 | FL | fed by odd (left) inputs |
| 1 | FR | fed by even (right) inputs |
| 2 | RL | left inputs, more delay than fronts |
| 3 | RR | right inputs, most delay |
| 4 | SUB_L | LPF 65 Hz, polarity inverted, delay 0 |
| 5 | SUB_R | same, right inputs |

✅ Confirmed by the clean default: out1–out4 take inputs IN1–IN4 one-to-one (the head unit's FL, FR, RL, RR high-level outputs), and out5/out6 take IN1/IN2. In the tuned `wuling` preset the right side has more delay than the left (FR 145 vs FL 130, RR 285 vs RL 238), which fits a right-hand-drive car with the driver on the right.

### Factory defaults (`clean_default.dspSingle`)

| | FL / FR | RL / RR | SUB_L / SUB_R |
|---|---|---|---|
| High-pass | 70 Hz, type 2, slope 3 | 80 Hz, type 2, slope 3 | off (slope 8) |
| Low-pass | off (slope 8) | off (slope 8) | 60 Hz, type 2, slope 3 |
| gain / delay / polar | 60 / 0 / 0 | 60 / 0 / 0 | 60 / 0 / 0 |
| All-pass | type 0, Q 27, 20 Hz | same | same |

The app screenshot of this default shows: HPF 70 Hz Butter_W 24dB/Oct, LPF OFF, every band Q 7.613 / 0.0 dB, every channel 0° / 0dB / 0.000 ms. All-pass type 0 with non-zero Q/Hz suggests type 0 = off.

### Per-output fields

| Field | Sample values | Meaning | Status |
|---|---|---|---|
| `EQ[31]` | — | 31 bands at ISO 1/3-octave centres 20 Hz…20 kHz | ✅ |
| `EQ[].freq` | 20…20000 | Band centre (Hz). Can it be moved off the ISO value? | ❓ |
| `EQ[].level` | 600, 585, 570, 606, 616 | `600` = 0 dB ✅; `0.1 dB` per step ⚠️ (585 → −1.5 dB) | ⚠️ |
| `EQ[].bw` | 14 everywhere | Bandwidth code. 14 = **Q 7.613** (shown in the app) | ✅ for 14; others ❓ |
| `EQ[].type` | 0 | Band filter type (0 = peaking?) | ⚠️ |
| `EQ[].shfDb` | 0 | Probably shelf-related | ❓ |
| `mute` | 1 on every output | `1` = playing, `0` = muted | ⚠️ |
| `polar` | 0 fronts/rears, 1 subs | `0` = 0° (shown in the app), `1` = 180° assumed | ⚠️ |
| `polarS` | 0 | Unknown | ❓ |
| `gain` | 60, 56, 54 | Channel level. **60 = 0 dB** (app shows 0dB, slider at top); step size ❓ | ⚠️ |
| `delay` | 130, 145, 238, 285, 0 | Channel delay. 0 = 0.000 ms; app shows ms with 3 decimals (unit selectable). Raw unit ❓ | ❓ |
| `hFreq` / `lFreq` | 20…20000 | High-pass / low-pass frequency (Hz) | ✅ |
| `hFilter` / `lFilter` | 0, 2 | Filter family. **2 = Butterworth** (app: "Butter_W"); 0, 1 ❓ | ✅ for 2 |
| `hLevel` / `lLevel` | 3, 8 | Slope. **3 = 24 dB/oct, 8 = OFF** (shown in the app); others assumed 0…7 = 6…48 dB/oct | ✅ for 3, 8 |
| `AllPassType/Q/Hz` | 0 | Per-output all-pass filter (useful for phase at the crossover) | ⚠️ |
| `IN1Vol`…`IN4Vol` | 0…100 | Mix level from high-level inputs 1–4 (head unit FL, FR, RL, RR) | ✅ |
| `IN5Vol`…`IN20Vol` | 0…106 | Other input/source routing; meaning of each slot unknown | ❓ never edit |

The tuned `wuling` preset sums front and rear head-unit inputs into each output (e.g. FL takes IN1 + IN3). For measurements, set the head unit's EQ flat, fader and balance centred, and any sound-field effects off, so the pink noise reaches every DSP input at the same level.
| `name` | 8 ASCII bytes | Output label, null-terminated | ✅ |

## `system`

Global settings (`mainVol`, source volumes, `out1SpkType`…, `UserGropName` = preset name `"wuling"` as 16 ASCII bytes). The calibration tool never edits these.

## Confirming the ⚠️/❓ fields: probe presets

`python -m carcal probe clean_default.dspSingle -o probes/` writes 9 probe presets. Each sets known raw values (a different value per channel), so one import tests six data points.

1. Import each probe into the app, note what the app displays (`PROBE_CHECKLIST.md`).
2. Export it straight back as `probe_NN_back.dspSingle`.
3. `python -m carcal probe-review probes/` lists every value the app clamped or rounded.

| Probe | Tests |
|---|---|
| 01 | EQ dB step size |
| 02 | EQ gain range (extreme values — volume at 0) |
| 03 | Bandwidth code ↔ Q |
| 04 | Whether band frequency/type can change (PEQ vs graphic EQ) |
| 05 | Delay unit |
| 06 | Channel gain unit |
| 07 | Mute and polarity values |
| 08 | Crossover type and slope codes |
| 09 | All-pass encoding |

Probes 01, 05, 06 and 07 matter most: they decide whether the tool can write EQ, delay and level safely.

## App automation

The Rainbow Windows app has no API; `carcal.dspgui` drives its dialogs (see `MCP_SETUP.md`):

- **Import:** Call → "Open" dialog → `import` → Windows picker titled `slect file` (sic) → path → Enter
- **Export:** Save → "Save" dialog (Single File) → `Save` → `slect file` picker → path → Enter

The picker filter is `*.dspSingle;*.dspAll`. `.dspAll` (multi-file save) is not decoded yet.

## EQ resolution note

With every band at Q 7.613, adjacent bands barely overlap, so a broad correction shows ripple between band centres. The REW converter measures this ripple and refuses to write when it exceeds `--max-err` (default 1.5 dB). If probe 03 shows wider bandwidth codes exist, the fitter can choose a width per band.
