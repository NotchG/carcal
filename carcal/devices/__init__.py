"""Supported DSP devices. Each entry says how the device's outputs are wired by default."""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).parent

DEVICES: dict[str, dict] = {
    "EL-PA4.6": {
        "id": "EL-PA4.6",
        "maker": "Rainbow",
        "name": "Rainbow EL-PA4.6",
        "description": "4-in / 6-out amplifier DSP, 31-band EQ per output",
        "outputs": ["FL", "FR", "RL", "RR", "SUB_L", "SUB_R"],
        "factory_default": str(HERE / "el_pa46_default.dspSingle"),
        # Front passive components, rear full-range, one sub on outputs 5+6.
        "default_channels": [
            {"key": "FL", "label": "Front left", "outputs": ["FL"], "role": "front",
             "hp_hz": 80, "lp_hz": None, "level_offset_db": 0, "pair": "FR"},
            {"key": "FR", "label": "Front right", "outputs": ["FR"], "role": "front",
             "hp_hz": 80, "lp_hz": None, "level_offset_db": 0, "pair": "FL"},
            {"key": "RL", "label": "Rear left", "outputs": ["RL"], "role": "rear",
             "hp_hz": 100, "lp_hz": None, "level_offset_db": -3, "pair": "RR"},
            {"key": "RR", "label": "Rear right", "outputs": ["RR"], "role": "rear",
             "hp_hz": 100, "lp_hz": None, "level_offset_db": -3, "pair": "RL"},
            {"key": "SUB", "label": "Subwoofer", "outputs": ["SUB_L", "SUB_R"], "role": "sub",
             "hp_hz": None, "lp_hz": 80, "level_offset_db": 0, "pair": None},
        ],
    },
}
