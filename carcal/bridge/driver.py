"""Device drivers: the only DSP-specific code in the bridge.

To support another DSP, write a DeviceDriver subclass. The bridge's HTTP API,
backups, verification and file handling stay the same.
"""

from __future__ import annotations

import abc
import math
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..calib.curves import GRID, smooth
from ..devices import DEVICES
from ..dsp_codec import Preset, describe_path, diff
from ..eq_fit import bank_db, fit_31band
from ..rew_filters import Filter as RewFilter
from ..rew_filters import parse_text, response_db
from ..spec import ISO_31, UNKNOWN
from .contract import (BridgeStatus, Capabilities, ChannelCompile, ChannelInfo, Crossover,
                       DeviceIdentity, EqCapability, PresetRequest, SettingCapability)


class ManualStep(RuntimeError):
    """The DSP can't be driven automatically here; the user must import a file."""


class RequestError(ValueError):
    """The preset request can't be applied to this device (bad channel, etc.)."""


@dataclass
class Compiled:
    native: bytes
    channels: dict[str, ChannelCompile]
    ignored: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class DeviceDriver(abc.ABC):
    native_ext: str = ".bin"

    @abc.abstractmethod
    def identity(self) -> DeviceIdentity: ...
    @abc.abstractmethod
    def channels(self) -> list[ChannelInfo]: ...
    @abc.abstractmethod
    def capabilities(self) -> Capabilities: ...
    @abc.abstractmethod
    def status(self) -> BridgeStatus: ...
    @abc.abstractmethod
    def factory_default(self) -> bytes: ...
    @abc.abstractmethod
    def validate_native(self, data: bytes) -> None: ...
    @abc.abstractmethod
    def compile(self, req: PresetRequest, baseline: bytes) -> Compiled: ...
    @abc.abstractmethod
    def load(self, path: Path) -> list[str]:
        """Load a native file into the DSP. Raise ManualStep if not automated."""
    @abc.abstractmethod
    def read_current(self, path: Path) -> list[str]:
        """Save the DSP's current state to a native file. Raise ManualStep if not automated."""
    @abc.abstractmethod
    def compare(self, sent: Path, got: Path) -> list[str]:
        """Human-readable differences that matter (used to verify a load)."""


# =====================================================================
# Rainbow EL-PA4.6
# =====================================================================
def _slope_code(p: Preset, slope_db_oct: int | None, current: int) -> tuple[int, str | None]:
    off = next(k for k, v in p.spec.slope_db_per_oct.items() if v is None)
    if slope_db_oct is None:
        return (3 if current == off else current), None
    for code, v in p.spec.slope_db_per_oct.items():
        if v == slope_db_oct:
            return code, None
    return (3 if current == off else current), f"slope {slope_db_oct} dB/oct not available; kept {p.spec.slope_db_per_oct.get(current)}"


class ElPa46Driver(DeviceDriver):
    native_ext = ".dspSingle"

    def __init__(self, app):
        """app: RainbowApp (real), SimDspApp (sim) or a ManualApp (no automation)."""
        self.app = app
        self.dev = DEVICES["EL-PA4.6"]
        self.map = {c["key"]: c for c in self.dev["default_channels"]}
        self.spec = Preset.load(self.dev["factory_default"]).spec

    # ---------------- description ----------------
    def identity(self) -> DeviceIdentity:
        return DeviceIdentity(id=self.dev["id"], maker=self.dev["maker"], name=self.dev["name"])

    def channels(self) -> list[ChannelInfo]:
        out = []
        for c in self.dev["default_channels"]:
            out.append(ChannelInfo(
                key=c["key"], label=c["label"], role=c["role"], pair=c["pair"],
                default_highpass=Crossover(hz=c["hp_hz"], slope_db_oct=24) if c["hp_hz"] else None,
                default_lowpass=Crossover(hz=c["lp_hz"], slope_db_oct=24) if c["lp_hz"] else None,
                default_level_offset_db=c["level_offset_db"]))
        return out

    def capabilities(self) -> Capabilities:
        s = self.spec
        return Capabilities(
            eq=EqCapability(kind="fixed", bands_hz=[float(f) for f in ISO_31], q=s.bw_to_q[14],
                            max_filters=31, gain_db=(s.eq_gain_min_db, s.eq_gain_max_db),
                            gain_step_db=1 / s.eq_level_per_db, filter_types=["PK"], fs_hz=s.fs),
            crossover_slopes_db_oct=[v for v in s.slope_db_per_oct.values() if v],
            crossover_types=["butterworth"],
            delay=SettingCapability(writable=s.delay_status != UNKNOWN,
                                    note=None if s.delay_status != UNKNOWN else
                                    "Delay unit not confirmed yet (probe 05): type delays in the app"),
            gain=SettingCapability(writable=s.gain_status != UNKNOWN,
                                   note=None if s.gain_status != UNKNOWN else
                                   "Channel gain unit not confirmed yet (probe 06)"),
            polarity=SettingCapability(writable=True),
            mute=SettingCapability(writable=True),
        )

    def status(self) -> BridgeStatus:
        try:
            st = self.app.status()
        except Exception as e:
            return BridgeStatus(automation=False, message=str(e))
        automated = not getattr(self.app, "manual", False)
        return BridgeStatus(automation=automated, app_found=st.get("window_found"),
                            amp_connected=st.get("connected"), message=st.get("error"))

    def factory_default(self) -> bytes:
        return Path(self.dev["factory_default"]).read_bytes()

    def validate_native(self, data: bytes) -> None:
        import json
        Preset(json.loads(data)).validate()

    # ---------------- compile ----------------
    def _eq(self, p: Preset, outputs: list[str], key: str, eq) -> ChannelCompile:
        s = p.spec
        q_dev = s.bw_to_q[14]
        warn: list[str] = []
        if eq is None or (eq.filters is not None and len(eq.filters) == 0 and not eq.rew_txt):
            p.flatten_eq(p.resolve(outputs))
            zeros = [0.0] * len(GRID)
            return ChannelCompile(eq_response_db=zeros, eq_exact=True, fit_rms_db=0, fit_max_db=0)
        if eq.rew_txt:
            filters = parse_text(eq.rew_txt)
        else:
            filters = [RewFilter(f.type, f.fc_hz, f.gain_db, f.q) for f in eq.filters]
        filters = [f for f in filters if f.gain_db != 0]

        # Exact mapping: every filter is a peaking band at one of the 31 centres with the device's Q.
        idx = {}
        exact = True
        for f in filters:
            j = int(np.argmin([abs(math.log(f.fc / c)) for c in ISO_31]))
            if (f.type != "PK" or abs(f.fc / ISO_31[j] - 1) > 0.01 or j in idx
                    or (f.q is not None and abs(f.q / q_dev - 1) > 0.02)):
                exact = False
                break
            idx[j] = f.gain_db
        gains = np.zeros(31)
        if exact:
            for j, g in idx.items():
                gains[j] = g
            requested = bank_db(gains, np.array(ISO_31, float), q_dev, GRID, s.fs).sum(axis=0)
        else:
            requested = response_db(filters, GRID, s.fs)
            fcs = [f.fc for f in filters] or [1000]
            lo, hi = max(20.0, min(fcs) / 2), min(20000.0, max(fcs) * 2)
            frac = np.where(GRID < 300, 1 / 6, 1 / 3)
            fit = fit_31band(requested, GRID, f_lo=lo, f_hi=hi, spec=s,
                             max_boost_db=s.eq_gain_max_db, max_cut_db=-s.eq_gain_min_db,
                             perceptual=frac)
            gains = np.array(fit.gains_db)
            warn.append(f"{key}: {len(filters)} parametric filters fitted onto the 31 fixed bands")
        step = 1 / s.eq_level_per_db
        clipped = gains < s.eq_gain_min_db - 1e-9
        clipped |= gains > s.eq_gain_max_db + 1e-9
        if clipped.any():
            warn.append(f"{key}: gain limited to {s.eq_gain_min_db:g}..{s.eq_gain_max_db:g} dB at "
                        + ", ".join(f"{ISO_31[i]} Hz" for i in np.where(clipped)[0]))
        gains = np.clip(np.round(gains / step) * step, s.eq_gain_min_db, s.eq_gain_max_db)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            p.set_eq_gains(p.resolve(outputs), gains.tolist())
        realised = bank_db(gains, np.array(ISO_31, float), q_dev, GRID, s.fs).sum(axis=0)
        # Error as heard: both curves smoothed (1/6 oct below 300 Hz, 1/3 above), over the
        # range the filters act on. The raw realised curve is returned as-is.
        fcs = [f.fc for f in filters] or [1000]
        band = (GRID >= max(20.0, min(fcs) / 2)) & (GRID <= min(20000.0, max(fcs) * 2))
        frac = np.where(GRID < 300, 1 / 6, 1 / 3)
        err = (smooth(realised, frac) - smooth(requested, frac))[band]
        return ChannelCompile(eq_response_db=np.round(realised, 3).tolist(), eq_exact=exact,
                              fit_rms_db=round(float(np.sqrt(np.mean(err ** 2))), 3),
                              fit_max_db=round(float(np.max(np.abs(err))), 3), warnings=warn)

    def _xover(self, p: Preset, outputs, which: str, xo, ignored: list[str], key: str):
        off = next(k for k, v in p.spec.slope_db_per_oct.items() if v is None)
        fk, lk, tk = ("hFreq", "hLevel", "hFilter") if which == "highpass" else ("lFreq", "lLevel", "lFilter")
        for i in p.resolve(outputs):
            o = p.outputs[i]
            if xo is None:
                o[fk], o[lk] = (20 if which == "highpass" else 20000), off
                continue
            o[fk] = int(round(min(20000, max(20, xo.hz))))
            o[lk], msg = _slope_code(p, xo.slope_db_oct, o[lk])
            if msg:
                ignored.append(f"{key} {which}: {msg}")
            if xo.type:
                if xo.type.lower().replace("_", "-") in ("butterworth", "butter-w"):
                    o[tk] = 2
                else:
                    ignored.append(f"{key} {which}: filter type '{xo.type}' not mapped yet; kept the device's")

    def compile(self, req: PresetRequest, baseline: bytes) -> Compiled:
        import json
        p = Preset(json.loads(baseline))
        unknown = set(req.channels) - set(self.map)
        if unknown:
            raise RequestError(f"unknown channels {sorted(unknown)}; this device has {list(self.map)}")
        out = Compiled(native=b"", channels={})
        caps = self.capabilities()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for key, cs in req.channels.items():
                outputs = self.map[key]["outputs"]
                fs = cs.model_fields_set
                if "mute" in fs and cs.mute is not None:
                    p.set_mute(outputs, cs.mute)
                if "polarity" in fs and cs.polarity is not None:
                    p.set_polarity(outputs, cs.polarity == "inverted")
                if "highpass" in fs:
                    self._xover(p, outputs, "highpass", cs.highpass, out.ignored, key)
                if "lowpass" in fs:
                    self._xover(p, outputs, "lowpass", cs.lowpass, out.ignored, key)
                if cs.delay_ms is not None:
                    if caps.delay.writable:
                        p.set_delay_ms(outputs, cs.delay_ms)
                    else:
                        out.ignored.append(f"{key}: delay {cs.delay_ms:.3f} ms not written ({caps.delay.note})")
                if cs.gain_db is not None:
                    out.ignored.append(f"{key}: gain {cs.gain_db:+.1f} dB not written ({caps.gain.note})")
                if "eq" in fs:
                    cc = self._eq(p, outputs, key, cs.eq)
                    out.channels[key] = cc
                    out.warnings += cc.warnings
        p.validate()
        out.native = p.to_bytes()
        return out

    # ---------------- device I/O ----------------
    def load(self, path: Path) -> list[str]:
        return self.app.import_preset(path)

    def read_current(self, path: Path) -> list[str]:
        return self.app.export_preset(path)

    def compare(self, sent: Path, got: Path) -> list[str]:
        a, b = Preset.load(sent), Preset.load(got)
        return [f"{describe_path(pth, a.channel_map)}: sent {x!r}, device has {y!r}"
                for pth, x, y in diff(a.data["outPuts"], b.data["outPuts"], "outPuts")]


class ManualApp:
    """Stand-in when the Rainbow app can't be automated (not Windows / not found)."""
    manual = True

    def __init__(self, reason: str):
        self.reason = reason

    def status(self) -> dict:
        return {"window_found": False, "error": self.reason}

    def import_preset(self, path):
        raise ManualStep(self.reason)

    def export_preset(self, path):
        raise ManualStep(self.reason)

    def screenshot(self):
        raise ManualStep(self.reason)

    def select_channel(self, n):
        raise ManualStep(self.reason)
