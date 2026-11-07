"""python -m carcal.bridge [--sim] [--port 8770] [--token T] [--data DIR]
   python -m carcal.bridge schema [-o contract/preset-v1.schema.json]
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
from pathlib import Path


def write_schema(out: Path) -> Path:
    from .contract import ApplyResult, CompileResult, DeviceDescription, PresetRequest, RestoreRequest
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "carcal preset contract v1",
        "description": "Messages between the carcal dashboard and a DSP bridge. Generated from "
                       "carcal/bridge/contract.py - do not edit by hand.",
        "definitions": {m.__name__: m.model_json_schema() for m in
                        (DeviceDescription, PresetRequest, CompileResult, ApplyResult, RestoreRequest)},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, indent=2) + "\n")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m carcal.bridge")
    ap.add_argument("cmd", nargs="?", choices=["serve", "schema"], default="serve")
    ap.add_argument("-o", "--output", default="contract/preset-v1.schema.json")
    ap.add_argument("--sim", action="store_true", help="simulated DSP + fake REW API for development")
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 so the Mac can reach it")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--token", default=os.environ.get("CARCAL_BRIDGE_TOKEN"))
    ap.add_argument("--data", default=os.environ.get("CARCAL_BRIDGE_DATA", str(Path.home() / "carcal_bridge")))
    ap.add_argument("--rew-port", type=int, default=4735, help="fake REW port in --sim mode")
    ap.add_argument("--manual-rew-save", action="store_true",
                    help="--sim: fake REW won't save RTA through the API (tests the manual path)")
    a = ap.parse_args(argv)

    if a.cmd == "schema":
        print(f"wrote {write_schema(Path(a.output))}")
        return

    import uvicorn
    from .app import create_app
    from .driver import ElPa46Driver, ManualApp
    from .service import BridgeService

    token = a.token
    if not token:
        # Keep one token per bridge so the dashboard doesn't need it again after a restart.
        tf = Path(a.data).expanduser() / "token.txt"
        tf.parent.mkdir(parents=True, exist_ok=True)
        if not tf.exists():
            tf.write_text(secrets.token_urlsafe(18))
        token = tf.read_text().strip()

    if a.sim:
        from ..calib.sim import SimCar, SimDspApp
        from ..devices import DEVICES
        from .fake_rew import create_fake_rew
        car = SimCar()
        app_ = SimDspApp(DEVICES["EL-PA4.6"]["factory_default"])
        rew = create_fake_rew(car, app_, auto_save=not a.manual_rew_save)
        threading.Thread(target=uvicorn.run, args=(rew,),
                         kwargs={"host": "127.0.0.1", "port": a.rew_port, "log_level": "warning"},
                         daemon=True).start()
        print(f"fake REW API on http://127.0.0.1:{a.rew_port}", flush=True)
        mode = "sim"
    elif sys.platform == "win32":
        try:
            from ..dspgui.app import RainbowApp
            from ..dspgui.config import load
            app_ = RainbowApp(load())
        except Exception as e:
            app_ = ManualApp(f"Rainbow app automation unavailable: {e}")
        mode = "real"
    else:
        app_ = ManualApp("Not on Windows: presets are compiled, import them in the Rainbow app yourself")
        mode = "real"

    svc = BridgeService(ElPa46Driver(app_), a.data, mode)
    import socket
    try:
        s_ = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s_.connect(("10.255.255.255", 1))
        lan = s_.getsockname()[0]; s_.close()
    except OSError:
        lan = "127.0.0.1"
    shown = lan if a.host in ("0.0.0.0", "") else a.host
    print("\n  carcal DSP bridge (" + mode + ")\n"
          f"  In the dashboard, connect a bridge with:\n"
          f"    address  http://{shown}:{a.port}\n"
          f"    token    {token}\n"
          f"  data: {svc.root}\n", flush=True)
    uvicorn.run(create_app(svc, token), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
