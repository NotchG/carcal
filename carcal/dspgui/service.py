"""What the MCP tools actually do, independent of how the app is driven.

Safety rules
  * The first import in a session is preceded by an export of whatever the app
    holds, saved in backups/, so your current tune is never lost.
  * Measurement presets are built from a *baseline* (your real tune, captured
    from the app), not from scratch: crossovers that protect the drivers are kept.
  * Every import can be verified by exporting straight back and comparing the
    output settings with what was sent.
"""

from __future__ import annotations

import threading
import time
import warnings
from datetime import datetime
from pathlib import Path

from ..dsp_codec import Preset, describe_path, diff
from ..probes import PROBES, apply as apply_probe
from .app import DspApp

CHANNEL_INDEX = {"FL": 1, "FR": 2, "RL": 3, "RR": 4, "SUB_L": 5, "SUB_R": 6, "SUB": 5}


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


class DspService:
    def __init__(self, app: DspApp, workdir: str | Path):
        self.app = app
        self.workdir = Path(workdir).expanduser().resolve()
        for d in ("backups", "measure", "exports", "verify", "probes"):
            (self.workdir / d).mkdir(parents=True, exist_ok=True)
        self.baseline_path = self.workdir / "baseline.dspSingle"
        self._backup_done = False
        self._lock = threading.Lock()

    # ---------------- basics ----------------
    def status(self) -> dict:
        s = dict(self.app.status())
        s["workdir"] = str(self.workdir)
        s["baseline"] = str(self.baseline_path) if self.baseline_path.exists() else None
        s["backup_taken_this_session"] = self._backup_done
        return s

    def screenshot(self):
        return self.app.screenshot()

    def select_channel(self, channel: int | str) -> str:
        n = CHANNEL_INDEX[channel.upper()] if isinstance(channel, str) else int(channel)
        with self._lock:
            return self.app.select_channel(n)

    def export(self, path: str | Path | None = None) -> tuple[Path, list[str]]:
        path = Path(path) if path else self.workdir / "exports" / f"export_{_ts()}.dspSingle"
        with self._lock:
            notes = self.app.export_preset(path)
        Preset.load(path)          # validates
        return path, notes

    def backup(self) -> Path:
        path, _ = self.export(self.workdir / "backups" / f"backup_{_ts()}.dspSingle")
        self._backup_done = True
        return path

    # ---------------- import ----------------
    def import_preset(self, path: str | Path, verify: bool = True) -> dict:
        path = Path(path).resolve()
        sent = Preset.load(path)                    # refuse to send a broken file
        result: dict = {"imported": str(path)}
        if not self._backup_done:
            result["backup"] = str(self.backup())
        with self._lock:
            result["notes"] = self.app.import_preset(path)
        if verify:
            back = self.workdir / "verify" / f"verify_{_ts()}.dspSingle"
            with self._lock:
                self.app.export_preset(back)
            got = Preset.load(back)
            mism = diff(sent.data["outPuts"], got.data["outPuts"], "outPuts")
            result["verified"] = not mism
            result["mismatches"] = [f"{describe_path(p, sent.channel_map)}: sent {a!r}, app has {b!r}"
                                    for p, a, b in mism][:40]
        return result

    # ---------------- baseline & measurement presets ----------------
    def capture_baseline(self) -> Path:
        """Export the app's current state as the baseline for measurement presets."""
        path, _ = self.export(self.baseline_path)
        self._backup_done = True        # the baseline is itself a backup of the current state
        return path

    def set_baseline(self, path: str | Path) -> Path:
        p = Preset.load(path)
        self.baseline_path.write_bytes(p.to_bytes())
        return self.baseline_path

    def baseline(self) -> Preset:
        if not self.baseline_path.exists():
            self.capture_baseline()
        return Preset.load(self.baseline_path)

    def load_solo(self, channels: list[str], *, flatten_eq: bool = True,
                  keep_crossovers: bool = True, verify: bool = True) -> dict:
        base = self.baseline()
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            solo = base.solo(channels, flatten_eq=flatten_eq, keep_crossovers=keep_crossovers)
        name = "_".join(c.upper() for c in channels)
        path = self.workdir / "measure" / f"solo_{name}.dspSingle"
        solo.save(path)
        result = self.import_preset(path, verify=verify)
        result["playing"] = [solo.name_of(i) for i in solo.resolve(channels)]
        result["warnings"] = sorted({str(x.message) for x in w})
        return result

    def restore_baseline(self, verify: bool = True) -> dict:
        if not self.baseline_path.exists():
            raise FileNotFoundError("no baseline captured yet")
        return self.import_preset(self.baseline_path, verify=verify)

    # ---------------- probes ----------------
    def run_probe(self, probe_id: str, base_path: str | Path | None = None,
                  per_channel_screenshots: bool = True) -> tuple[dict, list]:
        """Import a probe, export it back, and screenshot each channel's view."""
        probe = next((p for p in PROBES if p.id == probe_id.zfill(2)), None)
        if probe is None:
            raise KeyError(f"unknown probe {probe_id}; have {[p.id for p in PROBES]}")
        base = Preset.load(base_path) if base_path else self.baseline()
        d = self.workdir / "probes"
        sent = d / f"probe_{probe.id}.dspSingle"
        back = d / f"probe_{probe.id}_back.dspSingle"
        apply_probe(base, probe).save(sent)
        res = self.import_preset(sent, verify=False)
        with self._lock:
            self.app.export_preset(back)
        changed = diff(Preset.load(sent).data["outPuts"], Preset.load(back).data["outPuts"],
                       "outPuts")
        res.update({
            "probe": f"{probe.id} {probe.title}",
            "read_in_screenshots": probe.ask,
            "settings": [f"{s.channel} {s.field} = {s.raw}" for s in probe.settings],
            "app_changed_values": [f"{describe_path(p)}: sent {a!r}, saved {b!r}"
                                   for p, a, b in changed],
            "back_file": str(back),
        })
        shots = []
        if per_channel_screenshots:
            for n in range(1, 7):
                with self._lock:
                    self.app.select_channel(n)
                time.sleep(0.3)
                shots.append((f"CH{n}", self.app.screenshot()))
        else:
            shots.append(("app", self.app.screenshot()))
        return res, shots
