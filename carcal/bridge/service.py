"""Bridge state and operations, independent of HTTP and of the DSP model.

workdir/
  baseline.native + baseline.json   state that preset requests are patched onto
  files/<id>.native + <id>.json      every compiled preset (request + result)
  backups/                           DSP state saved before the first load of a session
  verify/                            read-backs used to check a load
  state.json                         id of the last 'tune' preset
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime
from pathlib import Path

from ..calib.curves import GRID
from . import __version__
from .contract import (ApplyResult, BaselineInfo, CompileResult, DeviceDescription, FileRef,
                       PresetRequest)
from .driver import DeviceDriver, ManualStep


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class BridgeService:
    def __init__(self, driver: DeviceDriver, workdir: str | Path, mode: str = "real"):
        self.d = driver
        self.mode = mode
        self.root = Path(workdir).expanduser().resolve()
        for sub in ("files", "backups", "verify"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._backup_done = False
        self.ext = driver.native_ext

    # ---------------- state ----------------
    def _state(self) -> dict:
        f = self.root / "state.json"
        return json.loads(f.read_text()) if f.exists() else {}

    def _set_state(self, **kw) -> None:
        s = self._state() | kw
        (self.root / "state.json").write_text(json.dumps(s, indent=2))

    @property
    def baseline_path(self) -> Path:
        return self.root / f"baseline{self.ext}"

    def baseline_info(self) -> BaselineInfo:
        meta = self.root / "baseline.json"
        if self.baseline_path.exists() and meta.exists():
            return BaselineInfo(**json.loads(meta.read_text()))
        return BaselineInfo(source="factory default")

    def baseline_bytes(self) -> bytes:
        return self.baseline_path.read_bytes() if self.baseline_path.exists() else self.d.factory_default()

    def _write_baseline(self, data: bytes, source: str) -> BaselineInfo:
        self.d.validate_native(data)
        self.baseline_path.write_bytes(data)
        info = BaselineInfo(source=source, at=_now())
        (self.root / "baseline.json").write_text(info.model_dump_json())
        return info

    # ---------------- description ----------------
    def describe(self) -> DeviceDescription:
        return DeviceDescription(bridge_version=__version__, mode=self.mode,
                                 device=self.d.identity(), status=self.d.status(),
                                 channels=self.d.channels(), capabilities=self.d.capabilities(),
                                 baseline=self.baseline_info())

    def file_path(self, fid: str) -> Path:
        if not all(c.isalnum() or c == "-" for c in fid):
            raise KeyError(fid)
        p = self.root / "files" / f"{fid}{self.ext}"
        if not p.exists():
            raise KeyError(fid)
        return p

    # ---------------- compile / apply ----------------
    def compile(self, req: PresetRequest) -> tuple[CompileResult, Path]:
        c = self.d.compile(req, self.baseline_bytes())
        fid = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        path = self.root / "files" / f"{fid}{self.ext}"
        path.write_bytes(c.native)
        safe = "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in req.name)[:60].strip() or "preset"
        res = CompileResult(preset_id=fid, freqs=[round(float(f), 3) for f in GRID],
                            channels=c.channels, ignored=c.ignored, warnings=c.warnings,
                            file=FileRef(id=fid, name=f"{safe}{self.ext}", url=f"/v1/files/{fid}"))
        (self.root / "files" / f"{fid}.json").write_text(json.dumps(
            {"request": req.model_dump(mode="json"), "result": res.model_dump(mode="json"), "at": _now()}))
        return res, path

    def _load_verified(self, path: Path) -> dict:
        """Back up (once per session), load, read back and compare."""
        out: dict = {"backup_id": None, "notes": []}
        with self.lock:
            if not self._backup_done:
                bid = "backup-" + datetime.now().strftime("%Y%m%d-%H%M%S")
                self.d.read_current(self.root / "backups" / f"{bid}{self.ext}")
                self._backup_done = True
                out["backup_id"] = bid
            out["notes"] = self.d.load(path)
            back = self.root / "verify" / f"verify-{datetime.now():%Y%m%d-%H%M%S}{self.ext}"
            self.d.read_current(back)
            out["mismatches"] = self.d.compare(path, back)[:40]
        return out

    def apply(self, req: PresetRequest) -> ApplyResult:
        res, path = self.compile(req)
        base = res.model_dump()
        try:
            r = self._load_verified(path)
        except ManualStep as e:
            return ApplyResult(**base, applied=False, manual=True, message=str(e))
        if req.purpose == "tune":
            self._set_state(last_tune=res.preset_id)
        mism = r["mismatches"]
        msg = "; ".join(r["notes"]) or None
        return ApplyResult(**base, applied=True, manual=False, verified=not mism,
                           mismatches=mism, backup_id=r["backup_id"], message=msg)

    def restore(self, to: str) -> dict:
        if to == "last-tune" and self._state().get("last_tune"):
            path = self.file_path(self._state()["last_tune"])
            what = f"last tune ({self._state()['last_tune']})"
        else:
            path = self.root / "verify" / f"restore-baseline{self.ext}"
            path.write_bytes(self.baseline_bytes())
            what = f"baseline ({self.baseline_info().source})"
        try:
            r = self._load_verified(path)
        except ManualStep as e:
            return {"restored": False, "manual": True, "message": str(e), "what": what}
        return {"restored": True, "manual": False, "what": what,
                "verified": not r["mismatches"], "mismatches": r["mismatches"],
                "backup_id": r["backup_id"]}

    def capture_baseline(self) -> BaselineInfo:
        tmp = self.root / "verify" / f"capture{self.ext}"
        with self.lock:
            self.d.read_current(tmp)
        self._backup_done = True              # the capture is itself a copy of the current state
        return self._write_baseline(tmp.read_bytes(), "captured")

    def upload_baseline(self, data: bytes) -> BaselineInfo:
        return self._write_baseline(data, "uploaded")
