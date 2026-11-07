"""HTTP API of the bridge (contract carcal.preset/1).

Every route except /v1/health needs `Authorization: Bearer <token>` when a
token is configured (always do this on a shared network).
"""

from __future__ import annotations

import hmac
import io

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response

from .contract import (CONTRACT, ApplyResult, CompileResult, DeviceDescription, PresetRequest,
                       RestoreRequest)
from .driver import ManualStep, RequestError
from .service import BridgeService


def create_app(svc: BridgeService, token: str | None) -> FastAPI:
    app = FastAPI(title="carcal DSP bridge", version="1")

    def auth(authorization: str | None = Header(default=None)):
        if not token:
            return
        given = (authorization or "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), token.encode()):
            raise HTTPException(401, "missing or wrong bridge token")

    def device_errors(fn):
        try:
            return fn()
        except RequestError as e:
            raise HTTPException(400, str(e))
        except ManualStep as e:
            raise HTTPException(409, str(e))
        except HTTPException:
            raise
        except Exception as e:                       # GUI automation failures etc.
            raise HTTPException(502, f"DSP: {e}")

    @app.get("/v1/health")
    def health():
        return {"ok": True, "contract": CONTRACT, "mode": svc.mode}

    @app.get("/v1/device", response_model=DeviceDescription, dependencies=[Depends(auth)])
    def device():
        return svc.describe()

    @app.post("/v1/presets/compile", response_model=CompileResult, dependencies=[Depends(auth)])
    def compile_(req: PresetRequest):
        return device_errors(lambda: svc.compile(req)[0])

    @app.post("/v1/presets/apply", response_model=ApplyResult, dependencies=[Depends(auth)])
    def apply(req: PresetRequest):
        return device_errors(lambda: svc.apply(req))

    @app.post("/v1/restore", dependencies=[Depends(auth)])
    def restore(req: RestoreRequest):
        return device_errors(lambda: svc.restore(req.to))

    @app.post("/v1/baseline/capture", dependencies=[Depends(auth)])
    def capture():
        return device_errors(lambda: svc.capture_baseline())

    @app.put("/v1/baseline", dependencies=[Depends(auth)])
    async def upload(request: Request):
        data = await request.body()
        try:
            return svc.upload_baseline(data)
        except Exception as e:
            raise HTTPException(400, f"not a valid {svc.ext} file for this device: {e}")

    @app.get("/v1/files/{fid}", dependencies=[Depends(auth)])
    def file(fid: str):
        try:
            p = svc.file_path(fid)
        except KeyError:
            raise HTTPException(404, "no such file")
        return FileResponse(p, filename=p.name, media_type="application/octet-stream")

    @app.get("/v1/screenshot", dependencies=[Depends(auth)])
    def screenshot():
        app_ = getattr(svc.d, "app", None)
        try:
            img = app_.screenshot()
        except Exception as e:
            raise HTTPException(409, str(e))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(buf.getvalue(), media_type="image/png")

    return app
