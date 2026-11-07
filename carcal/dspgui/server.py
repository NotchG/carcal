"""MCP server for the Rainbow EL-PA4.6 DSP app.

Run on the Windows laptop where the Rainbow app is open:
    python -m carcal.dspgui serve
"""

from __future__ import annotations

import io
import json
import logging
import os
from pathlib import Path

try:                                     # mcp >= 2
    from mcp.server.mcpserver import Image, MCPServer as _Server
except ImportError:                      # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server, Image  # type: ignore

from ..dsp_codec import Preset, describe_path, diff
from .service import DspService

log = logging.getLogger("carcal.dspgui")

INSTRUCTIONS = """\
Controls the Rainbow EL-PA4.6 car DSP app on this Windows PC by clicking its
Call (import) and Save (export) dialogs. Presets are .dspSingle JSON files.

- The first import in a session automatically backs up the app's current state.
- For per-speaker RTA measurements use dsp_load_solo (e.g. ["RR"]): it builds a
  preset from the baseline (the user's tune) with only that channel playing, EQ
  flat and protective crossovers kept, imports it and verifies it.
- Call dsp_restore_baseline when measurements are done.
- Imports change what the amplifier plays. Ask the user to keep the volume low
  for probes, and never run probe 02 unless they confirm the volume is at 0.
- If a tool reports a missed click or a mismatch, call dsp_screenshot and look.
"""


def _image(img, max_width: int = 1280) -> Image:
    if img.width > max_width:
        img = img.resize((max_width, int(img.height * max_width / img.width)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG", optimize=True)
    return Image(data=buf.getvalue(), format="png")


def _text(obj) -> str:
    return json.dumps(obj, indent=2, default=str)


def build_server(service: DspService) -> _Server:
    mcp = _Server("rainbow-dsp", instructions=INSTRUCTIONS)

    @mcp.tool()
    def dsp_status() -> str:
        """Is the app open, is it connected to the amp, where are files kept."""
        return _text(service.status())

    @mcp.tool(structured_output=False)
    def dsp_screenshot():
        """Screenshot of the DSP app window."""
        return [_image(service.screenshot())]

    @mcp.tool()
    def dsp_export(path: str | None = None) -> str:
        """Save the app's current settings to a .dspSingle file (default: workdir/exports)."""
        p, notes = service.export(path)
        return _text({"exported": str(p), "notes": notes, "summary": Preset.load(p).summary()})

    @mcp.tool()
    def dsp_import(path: str, verify: bool = True) -> str:
        """Load a .dspSingle file into the app (and the amp, if connected).

        verify=True exports straight back and reports any output setting the app changed.
        """
        return _text(service.import_preset(path, verify=verify))

    @mcp.tool()
    def dsp_capture_baseline() -> str:
        """Export the app's current state as the baseline for measurement presets."""
        p = service.capture_baseline()
        return _text({"baseline": str(p), "summary": Preset.load(p).summary()})

    @mcp.tool()
    def dsp_set_baseline(path: str) -> str:
        """Use an existing .dspSingle file as the baseline."""
        p = service.set_baseline(path)
        return _text({"baseline": str(p), "summary": Preset.load(p).summary()})

    @mcp.tool()
    def dsp_load_solo(channels: list[str], flatten_eq: bool = True,
                      keep_crossovers: bool = True, verify: bool = True) -> str:
        """Play only the given channels, for RTA measurement of one speaker.

        channels: any of FL, FR, RL, RR, SUB_L, SUB_R, or groups FRONT, REAR, SUB.
        Built from the baseline: other channels muted, EQ flat on the playing
        channels, crossovers kept to protect the drivers.
        """
        return _text(service.load_solo(channels, flatten_eq=flatten_eq,
                                       keep_crossovers=keep_crossovers, verify=verify))

    @mcp.tool()
    def dsp_restore_baseline(verify: bool = True) -> str:
        """Load the baseline back into the app (end of a measurement session)."""
        return _text(service.restore_baseline(verify=verify))

    @mcp.tool()
    def dsp_select_channel(channel: str) -> str:
        """Show a channel in the app's editor: 1-6 or FL, FR, RL, RR, SUB_L, SUB_R."""
        ch = int(channel) if channel.isdigit() else channel
        return _text({"selected": channel, "method": service.select_channel(ch)})

    @mcp.tool()
    def dsp_info(path: str) -> str:
        """Decode a .dspSingle file into readable settings."""
        return Preset.load(path).summary()

    @mcp.tool()
    def dsp_diff(path_a: str, path_b: str) -> str:
        """List every setting that differs between two .dspSingle files."""
        a, b = Preset.load(path_a), Preset.load(path_b)
        ch = diff(a.data, b.data)
        return "\n".join(f"{describe_path(p, a.channel_map)}: {x!r} -> {y!r}"
                         for p, x, y in ch) or "identical"

    @mcp.tool(structured_output=False)
    def dsp_run_probe(probe_id: str, volume_is_zero: bool = False):
        """Run one converter-calibration probe (01-09).

        Imports the probe built from the baseline, exports it back to see what the
        app clamped, and returns a screenshot of each channel so the displayed
        values can be read. Restore the baseline when all probes are done.
        Probe 02 holds extreme EQ boosts: refused unless volume_is_zero=True.
        """
        if probe_id.zfill(2) == "02" and not volume_is_zero:
            return ["Refused: probe 02 contains extreme EQ boosts. Ask the user to set the "
                    "head unit volume to 0, then call again with volume_is_zero=true."]
        res, shots = service.run_probe(probe_id)
        out: list = [_text(res)]
        for label, img in shots:
            out += [f"{label}:", _image(img)]
        return out

    return mcp


def main() -> None:
    logging.basicConfig(level=os.environ.get("CARCAL_LOG", "INFO"),
                        format="%(asctime)s %(levelname)s %(message)s")  # stderr; stdout is MCP
    from .app import RainbowApp
    from .config import load
    cfg = load()
    workdir = Path(os.environ.get("CARCAL_WORKDIR", Path.home() / "carcal_dsp"))
    build_server(DspService(RainbowApp(cfg), workdir)).run()
