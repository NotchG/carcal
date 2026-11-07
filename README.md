# carcal: automated car audio calibration

Measure each speaker with REW the way the CAT-BUG guide does it, pick a target curve, nudge bass/mids/highs, and press **Apply**. carcal designs the EQ and crossovers and loads them into the DSP for you.

```
 Mac laptop                                     Windows laptop (next to the DSP)
┌───────────────────────────────┐              ┌──────────────────────────────────┐
│ REW (API on :4735)            │              │ carcal DSP bridge (:8770)        │
│   ▲ RTA start/stop/pull       │  preset      │   converts presets to .dspSingle │
│ carcal dashboard (Next.js)    │  contract    │   loads them into the Rainbow    │
│   UI + API routes + SQLite    │ ───────────▶ │   app, reads back, verifies      │
│   target curves, EQ design    │  HTTP+token  │   ▼                              │
└───────────────────────────────┘              │ Rainbow app ── USB ── EL-PA4.6   │
       Audyssey mic                            └──────────────────────────────────┘
```

- The **dashboard** never knows how a DSP works. It sends generic preset requests (`carcal.preset/1`, see [contract/README.md](contract/README.md)) and reads the DSP's capabilities (how many EQ bands, which Q) from the bridge.
- The **bridge** is the only DSP-specific piece. Supporting another DSP means writing another bridge driver.
- Pink noise plays from your phone through Android Auto the whole time. The bridge mutes every speaker except the one being measured.

## What's automated and what isn't

| Step | Who |
|---|---|
| Muting all speakers but one for each measurement, and restoring your settings afterwards | carcal (through the bridge) |
| Starting and stopping REW's RTA, saving and pulling the measurement | carcal (through REW's API) |
| Target curve, tone, levels, EQ design for the 31-band EQ, crossovers | carcal |
| Converting to `.dspSingle`, loading it into the Rainbow app, checking it loaded | bridge |
| Placing the mic, playing pink noise, measuring speaker distances with a tape | you |
| Delays and channel gain | you, typed into the Rainbow app (shown on the dashboard), until their units in the file are confirmed |

## Setup

Both laptops must be on the same network (a phone hotspot works).

### Windows laptop (bridge)

1. Install Python 3.11+ and this folder, then:
   ```
   pip install -e .[bridge,gui]
   ```
2. Open the Rainbow app, connect it to the amp, and leave it open (not minimised).
3. Double-click `start-bridge.bat` (or run `python -m carcal.bridge`). It prints:
   ```
   carcal DSP bridge (real)
   In the dashboard, connect a bridge with:
     address  http://192.168.x.y:8770
     token    ...
   ```
   The token is saved in `%USERPROFILE%\carcal_bridge\token.txt`, so it stays the same after a restart.
4. When Windows asks, allow Python on **Private** networks.

Before the first real run, check that the Rainbow app's Call/Save dialogs can be driven: run `python -m carcal.dspgui test-export` and `test-import` as described in [MCP_SETUP.md](MCP_SETUP.md) (step 2). If automation isn't available, the bridge still works in manual mode: it builds each file and the dashboard gives you a download link to import by hand.

### Mac laptop (dashboard + REW)

1. In REW, turn on the API (Preferences → API, or start REW with `-api`). Load the Audyssey mic's cal file in REW's mic settings.
2. Install Node 20+ and build the dashboard once:
   ```
   cd web
   npm install
   npm run build
   ```
3. Double-click `web/start-dashboard.command` (or run `npm run start` in `web`), then open http://localhost:3000.
4. In the garage, connect the bridge with the address and token it printed, then add your car.

Everything is stored in one SQLite file, `~/carcal_data/carcal.db` (set `CARCAL_DB` to move it). REW's address defaults to `http://127.0.0.1:4735` and can be changed under Connections.

## Using it

1. **Garage:** pick the bridge (the DSP) and the car on one card.
2. **One-time setup** (only if the car has no measurements): checklist, read the DSP's current settings as the baseline, record the noise floor, measure each speaker with the others muted, enter distances, then restore your settings. Each measurement shows an animated guide: a top view of the car (which speaker is playing, where the mic goes) and a front view of the mic technique (upright and pointing at the roof, tennis-ball circles around one ear, then the other; held still at the headrest for the subwoofer and the noise floor). The steering-wheel side, chosen when you add the car, puts the mic at the driver's seat.
3. **Dashboard:** choose a target curve, move the Bass / Mids / Highs sliders, preview the predicted response, and press **Apply to DSP**. *Design with REW (experimental)* lets REW's Match Target design the filters instead. Every applied preset is kept in the history, where you can load it again or download it as a `.dspSingle` or as REW filters.

## Try it without the car

```
pip install -e .[bridge,dev]
python -m carcal.bridge --sim          # simulated DSP + fake REW on :4735
cd web && npm run dev                  # http://localhost:3000
```

Connect the bridge at `http://127.0.0.1:8770` with the printed token. The fake REW "measures" a simulated car through whatever the simulated DSP is set to, so the whole flow works end to end.

## Tests

```
python -m pytest -q tests              # codec, bridge, engine, Rainbow app automation
cd web && npm test                     # TypeScript engine against the Python golden results
```

After changing the Python engine, regenerate the golden file with `PYTHONPATH=. python tests/make_golden.py`. After changing the contract, regenerate the schema with `python -m carcal.bridge schema`.

## Layout

| Path | What |
|---|---|
| `web/` | Dashboard: Next.js UI, API routes (`app/api`), SQLite (`lib/server`), calibration engine (`lib/engine`) |
| `carcal/bridge/` | DSP bridge: contract models, EL-PA4.6 driver, service, HTTP app, sim mode |
| `carcal/dsp_codec.py`, `spec.py`, `eq_fit.py`, `rew_filters.py` | `.dspSingle` format, device spec, 31-band fitting, REW filter parsing |
| `carcal/dspgui/` | Rainbow app automation (pywinauto) and the optional MCP server |
| `carcal/calib/` | Python reference engine and simulator |
| `contract/` | Preset contract docs and generated JSON schema |
| `FORMAT.md` | What's known about the `.dspSingle` format |

## Known limits

- Tested against the simulator only. The first real run should start from a backup (the bridge makes one per session in `carcal_bridge/backups`).
- Delay and gain units in `.dspSingle` aren't confirmed, so the bridge doesn't write them and reports them as ignored.
- EQ level scale (600 = 0 dB, 0.1 dB per step) and mute value are assumed; load the probe presets described in FORMAT.md once to confirm.
- *Design with REW* relies on REW API endpoints that vary between REW versions; if a step fails, the dashboard names it.
