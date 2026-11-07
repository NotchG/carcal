# Rainbow DSP MCP server — setup (Windows)

The server clicks through the Rainbow app's **Call** (import) and **Save** (export) dialogs, so Claude can load presets — for example "only RR playing" for an RTA capture — without you touching the app.

## 1. Install

On the laptop that runs the Rainbow app (Python 3.11+):

```
cd C:\path\to\carcal
pip install -e .[gui]
```

## 2. First check, without Claude

Open the Rainbow app (not minimised), then in a terminal:

```
python -m carcal.dspgui test-export %USERPROFILE%\carcal_dsp\first_export.dspSingle
```

You'll see the mouse click **Save → Save → file picker**. The output line shows how each button was found:

| Method | Meaning |
|---|---|
| `uia` | The app exposes the button to Windows UI Automation — most reliable |
| `template 0.9x` | Found by matching the screenshot of the button |
| `position` | Fell back to a fixed position (toolbar buttons only) |

Then try an import of that same file:

```
python -m carcal.dspgui test-import %USERPROFILE%\carcal_dsp\first_export.dspSingle
```

If either fails, run `python -m carcal.dspgui inspect` and send me `dspgui_inspect.txt` plus a screenshot.

## 3. Add to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rainbow-dsp": {
      "command": "python",
      "args": ["-m", "carcal.dspgui", "serve"],
      "env": { "CARCAL_WORKDIR": "C:\\Users\\YOU\\carcal_dsp" }
    }
  }
}
```

Restart Claude Desktop. The REW MCP server goes in the same file, next to this one.

## Tools

| Tool | What it does |
|---|---|
| `dsp_status` | App open? Connected to the amp? Where files are kept |
| `dsp_screenshot` | Picture of the app window |
| `dsp_export` / `dsp_import` | Save / load a `.dspSingle`; import verifies by exporting back |
| `dsp_capture_baseline` | Save your current tune as the base for measurement presets |
| `dsp_load_solo` | e.g. `["RR"]`: only RR plays, EQ flat, crossovers kept, verified |
| `dsp_restore_baseline` | Put your tune back after measuring |
| `dsp_select_channel` | Show CH1–CH6 in the editor |
| `dsp_run_probe` | Run a calibration probe and screenshot every channel |
| `dsp_info` / `dsp_diff` | Decode / compare preset files |

## Safety built in

- **Automatic backup:** the first import of every session exports the app's current state to `backups\` first.
- **No blind clicks on dialogs:** if the Open/Save dialog's button can't be found, the tool stops instead of clicking where the button should be (that spot is over the EQ sliders).
- **Verification:** after an import, the app's state is exported and compared with what was sent; any value the app changed is reported.
- **Probe 02** (extreme EQ) is refused unless Claude confirms you set the volume to 0.
- The cursor is put back where it was after each operation.

## While it runs

- Keep the Rainbow app visible (not minimised, not covered by another full-screen window).
- Don't move the mouse during an import/export (about 3–5 seconds each).
- The app must show **Connected** for imports to reach the amp. "Not Connected" only changes the app's screen.
- Leave the Save dialog on **Single File** (the default).
