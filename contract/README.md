# Preset contract v1 (`carcal.preset/1`)

The only thing the dashboard and a DSP bridge share. The dashboard never knows which DSP sits behind a bridge or how presets get into it; a bridge never knows about targets, tone or measurements.

- Source of truth: `carcal/bridge/contract.py` (Pydantic)
- Generated schema: `preset-v1.schema.json` (`python -m carcal.bridge schema`)
- TypeScript mirror: `web/lib/contract.ts`

## Endpoints a bridge implements

All but `/v1/health` require `Authorization: Bearer <token>`.

| Method | Path | Body → result |
|---|---|---|
| GET | `/v1/health` | → `{ok, contract, mode}` |
| GET | `/v1/device` | → `DeviceDescription`: identity, status, logical channels with default crossovers, generic capabilities, baseline |
| POST | `/v1/presets/compile` | `PresetRequest` → `CompileResult` (dry run: realised EQ per channel, warnings, native file) |
| POST | `/v1/presets/apply` | `PresetRequest` → `ApplyResult` (compile, back up once per session, load, read back, verify) |
| POST | `/v1/restore` | `{to: "last-tune" \| "baseline"}` |
| POST | `/v1/baseline/capture` | read the DSP's current state as the baseline |
| PUT | `/v1/baseline` | raw native file as the baseline |
| GET | `/v1/files/{id}` | native file, for importing by hand |

## Preset requests are patches

```json
{
  "contract": "carcal.preset/1",
  "name": "neutral, bass +2",
  "purpose": "tune",
  "channels": {
    "FL":  { "mute": false, "highpass": { "hz": 80, "slope_db_oct": 24 },
             "eq": { "rew_txt": "Filter  1: ON  PK  Fc 125.0 Hz  Gain -5.00 dB  Q 7.613\n" } },
    "RR":  { "mute": true },
    "SUB": { "lowpass": null, "eq": null }
  }
}
```

- A field left out keeps the bridge's baseline value. `highpass`/`lowpass: null` means no filter; `eq: null` or an empty filter list means flat EQ.
- EQ is REW's "filter settings as text" (`rew_txt`) or the same filters as JSON (`filters`).
- `purpose: "tune"` marks the preset `/v1/restore` returns to. Measurement presets (`"measure"`) are ordinary requests: every other channel `mute: true`, the measured one `eq: null`.
- Settings a device can't write yet (e.g. delay) are reported in `ignored`, never silently dropped.

## Capabilities drive the EQ design, generically

`capabilities.eq` tells the dashboard what kind of EQ the DSP has, without naming the DSP:

- `kind: "fixed"`: bands at `bands_hz`, all with Q `q`, only gain adjustable (e.g. a 31-band graphic EQ). The dashboard designs on exactly these bands, so the bridge maps them 1:1 (`eq_exact: true`).
- `kind: "parametric"`: up to `max_filters` peaking filters with Q in `q_range`.

Filters that don't match the device (e.g. from REW's Match target) are fitted by the bridge; the `CompileResult` reports the realised response and the fit error as heard.

## Adding a DSP

Write a `DeviceDriver` subclass in `carcal/bridge/driver.py` (identity, channels, capabilities, compile, load, read_current, compare) and start the bridge with it. Nothing in the dashboard changes.
