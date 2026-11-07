"""A stand-in for REW's REST API, for development without the car.

Started by `python -m carcal.bridge --sim`. It "measures" whatever the
simulated DSP inside the sim bridge is playing, and implements the endpoints
the dashboard uses: RTA control, measurements, imports and the EQ / Match
target flow behind "Design with REW". Data comes back the way REW sends it
(base64 big-endian float32, startFreq + ppo).
"""

from __future__ import annotations

import base64
import math
import struct
import uuid
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Request

from ..calib.curves import GRID, smooth, to_grid
from ..calib.sim import SimCar, SimDspApp
from ..eq_fit import fit_31band
from ..spec import ISO_31

PPO = 48
REW_FREQS = 20.0 * 2 ** (np.arange(int(math.log2(1000) * PPO) + 1) / PPO)


def _b64(values) -> str:
    return base64.b64encode(struct.pack(f">{len(values)}f", *values)).decode()


def create_fake_rew(car: SimCar, dsp: SimDspApp, auto_save: bool = True) -> FastAPI:
    app = FastAPI(title="fake REW API")
    st = {"running": False, "averages": 0, "measurements": {}, "order": [],
          "house": None, "match": {}, "targets": {}, "levels": {}, "filters": {}, "pink": True}

    def read_mic() -> np.ndarray:
        if not st["pink"]:
            return car.noise + car.rng.normal(0, 0.5, len(GRID))
        return car.measure(dsp.preset())

    def add(title: str, grid_spl: np.ndarray) -> str:
        uid = str(uuid.uuid4())
        st["measurements"][uid] = {"title": title, "spl": grid_spl}
        st["order"].append(uid)
        return uid

    # ---------------- test hooks (not part of REW) ----------------
    @app.post("/_sim/pink")
    def sim_pink(on: bool = Body(..., embed=True)):
        st["pink"] = on
        return {"pink": on}

    # ---------------- measurements ----------------
    @app.get("/measurements")
    def measurements():
        return [{"uuid": u, "title": st["measurements"][u]["title"]} for u in st["order"]]

    @app.get("/measurements/{uid}/frequency-response")
    def fr(uid: str, ppo: int = 48):
        m = st["measurements"].get(uid)
        if m is None:
            raise HTTPException(404, "no such measurement")
        spl = np.interp(np.log10(REW_FREQS), np.log10(GRID), m["spl"])
        return {"startFreq": float(REW_FREQS[0]), "ppo": PPO, "magnitude": _b64(spl.tolist())}

    # ---------------- RTA ----------------
    @app.get("/rta/commands")
    def rta_commands():
        return ["Start", "Stop", "Reset"] + (["Save current"] if auto_save else [])

    @app.post("/rta/command")
    def rta_command(body: dict):
        cmd = body.get("command")
        if cmd == "Start":
            st["running"], st["averages"] = True, 0
        elif cmd == "Stop":
            st["running"] = False
        elif cmd == "Reset":
            st["averages"] = 0
        elif cmd == "Save current" and auto_save:
            add(f"RTA {len(st['order']) + 1}", read_mic())
        else:
            raise HTTPException(400, f"unknown command {cmd}")
        return {"message": f"{cmd} done"}

    @app.get("/rta/levels")
    def rta_levels():
        if st["running"]:
            st["averages"] = min(st["averages"] + 12, 999)
        spl = np.interp(np.log10(REW_FREQS), np.log10(GRID), read_mic())
        return {"startFreq": float(REW_FREQS[0]), "ppo": PPO, "magnitude": _b64(spl.tolist()),
                "averages": st["averages"]}

    # ---------------- imports ----------------
    @app.post("/import/frequency-response-data")
    def import_data(body: dict):
        f, m = body.get("frequencies"), body.get("magnitudes")
        if not f or not m or len(f) != len(m):
            raise HTTPException(400, "frequencies and magnitudes required")
        return {"uuid": add(body.get("title", "imported"), to_grid(f, m))}

    # ---------------- EQ / Match target ----------------
    @app.get("/eq/house-curve")
    def get_house():
        return {"filePath": st["house"] or ""}

    @app.post("/eq/house-curve")
    def set_house(body: dict):
        path = body.get("filePath") or body.get("path")
        if not path or not Path(path).exists():
            raise HTTPException(400, "house curve file not found")
        pts = [tuple(map(float, l.split()[:2])) for l in Path(path).read_text().splitlines()
               if l.strip() and l.strip()[0].isdigit()]
        st["house"] = path
        st["house_pts"] = pts
        return {"message": "house curve set"}

    @app.post("/measurements/{uid}/equaliser")
    def equaliser(uid: str, body: dict):
        return {"message": f"equaliser {body}"}

    @app.api_route("/measurements/{uid}/target-settings", methods=["PUT", "POST"])
    def target_settings(uid: str, body: dict):
        st["targets"][uid] = body
        return {"message": "ok"}

    @app.api_route("/measurements/{uid}/room-curve-settings", methods=["PUT", "POST"])
    def room_curve(uid: str, body: dict):
        return {"message": "ok"}

    @app.post("/measurements/{uid}/target-level")
    async def target_level(uid: str, request: Request):
        st["levels"][uid] = float((await request.body()).decode())
        return {"message": "ok"}

    @app.post("/eq/match-target-settings")
    def match_settings(body: dict):
        st["match"] = body
        return {"message": "ok"}

    @app.post("/measurements/{uid}/eq/command")
    def eq_command(uid: str, body: dict):
        if body.get("command") != "Match target":
            raise HTTPException(400, "unknown command")
        m = st["measurements"].get(uid)
        if m is None or not st.get("house_pts"):
            raise HTTPException(400, "measurement or house curve missing")
        f, g = zip(*st["house_pts"])
        target = to_grid(f, g) + st["levels"].get(uid, 0.0)
        lo = float(st["match"].get("startFrequency", 20)); hi = float(st["match"].get("endFrequency", 20000))
        boost = float(st["match"].get("individualMaxBoostdB", 6))
        corr = np.clip(target - smooth(m["spl"], 1 / 6), -12, boost)
        corr = np.where((GRID >= lo) & (GRID <= hi), corr, 0)
        # REW places free parametric filters; approximating with 1/3-octave Q 4.3 bands
        # still exercises the bridge's refit onto the device grid.
        fit = fit_31band(corr, GRID, f_lo=lo, f_hi=hi, max_boost_db=boost, max_cut_db=12,
                         perceptual=np.full(len(GRID), 1 / 6))
        q = 4.318
        st["filters"][uid] = [{"index": i + 1, "type": "PK", "enabled": True, "frequency": fc,
                               "gaindB": gg, "q": q}
                              for i, (fc, gg) in enumerate((fc, gg) for fc, gg in zip(ISO_31, fit.gains_db)
                                                           if abs(gg) >= 0.2)]
        return {"message": "Match target done"}

    @app.get("/measurements/{uid}/filters")
    def filters(uid: str):
        return st["filters"].get(uid, [])

    return app
