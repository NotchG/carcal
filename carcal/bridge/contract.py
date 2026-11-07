"""Preset contract v1 ("carcal.preset/1") - the only thing dashboard and bridge share.

Everything is in physical units (Hz, dB, ms). A preset request is a *patch*:
fields a channel leaves out keep whatever the bridge's baseline has. For the
crossovers, an explicit null means "no filter", while leaving the key out
means "keep the baseline's filter".

The JSON Schema in contract/preset-v1.schema.json is generated from these
models (python -m carcal.bridge schema).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CONTRACT = "carcal.preset/1"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------- device description ----------------
class Crossover(_Strict):
    hz: float = Field(ge=10, le=24000)
    slope_db_oct: int | None = Field(default=None, description="e.g. 12, 24; null = device default")
    type: str | None = Field(default=None, description="e.g. 'butterworth', 'linkwitz-riley'")


class ChannelInfo(_Strict):
    key: str = Field(description="Logical channel, e.g. FL, FR, RL, RR, SUB")
    label: str
    role: Literal["front", "rear", "sub", "center", "other"] = "other"
    pair: str | None = Field(default=None, description="Left/right partner, for level matching")
    default_highpass: Crossover | None = None
    default_lowpass: Crossover | None = None
    default_level_offset_db: float = 0.0


class EqCapability(_Strict):
    kind: Literal["fixed", "parametric"] = Field(
        description="fixed: bands at set frequencies with one Q, only gain adjustable. "
                    "parametric: free frequency/gain/Q per filter")
    bands_hz: list[float] | None = Field(default=None, description="Band centres for kind=fixed")
    q: float | None = Field(default=None, description="The single Q of every band, kind=fixed")
    q_range: tuple[float, float] | None = Field(default=None, description="kind=parametric")
    max_filters: int
    gain_db: tuple[float, float] = Field(description="Allowed gain per band/filter")
    gain_step_db: float = 0.1
    filter_types: list[str] = ["PK"]
    fs_hz: float = 48000


class SettingCapability(_Strict):
    supported: bool = True
    writable: bool = Field(description="False: the bridge reports it but won't write it yet")
    note: str | None = None


class Capabilities(_Strict):
    eq: EqCapability
    crossover_slopes_db_oct: list[int] = []
    crossover_types: list[str] = []
    delay: SettingCapability
    gain: SettingCapability
    polarity: SettingCapability
    mute: SettingCapability


class DeviceIdentity(_Strict):
    id: str
    maker: str
    name: str


class BridgeStatus(_Strict):
    automation: bool = Field(description="The bridge can load presets into the DSP itself")
    app_found: bool | None = None
    amp_connected: bool | None = None
    message: str | None = None


class BaselineInfo(_Strict):
    source: Literal["captured", "uploaded", "factory default"]
    at: str | None = None


class DeviceDescription(_Strict):
    contract: str = CONTRACT
    bridge_version: str
    mode: Literal["real", "sim"]
    device: DeviceIdentity
    status: BridgeStatus
    channels: list[ChannelInfo]
    capabilities: Capabilities
    baseline: BaselineInfo


# ---------------- preset request ----------------
class Filter(_Strict):
    type: Literal["PK", "LS", "HS", "LSC", "HSC"] = "PK"
    fc_hz: float = Field(gt=0, le=24000)
    gain_db: float = Field(ge=-30, le=30)
    q: float | None = Field(default=None, gt=0, le=50)


class Eq(_Strict):
    """Replace the channel's EQ. Give either filters (JSON) or rew_txt (REW's
    'Export filter settings as text'). An empty filter list means flat."""
    filters: list[Filter] | None = None
    rew_txt: str | None = None


class ChannelSettings(_Strict):
    mute: bool | None = None
    gain_db: float | None = Field(default=None, ge=-60, le=12)
    delay_ms: float | None = Field(default=None, ge=0, le=50)
    polarity: Literal["normal", "inverted"] | None = None
    highpass: Crossover | None = None
    lowpass: Crossover | None = None
    eq: Eq | None = None


class PresetRequest(_Strict):
    contract: Literal["carcal.preset/1"] = CONTRACT
    name: str = Field(default="carcal preset", max_length=120)
    purpose: Literal["tune", "measure", "test"] = Field(
        default="tune", description="'tune' presets become the 'last applied' one to restore")
    channels: dict[str, ChannelSettings]


# ---------------- results ----------------
class ChannelCompile(_Strict):
    eq_response_db: list[float] = Field(description="Realised EQ on the shared grid")
    eq_exact: bool = Field(description="True when the filters mapped 1:1 onto the device")
    fit_rms_db: float = Field(description="Realised vs requested EQ, both smoothed like hearing "
                                          "(1/6 oct below 300 Hz, 1/3 above), over the filters' range")
    fit_max_db: float
    warnings: list[str] = []


class FileRef(_Strict):
    id: str
    name: str
    url: str


class CompileResult(_Strict):
    contract: str = CONTRACT
    preset_id: str
    freqs: list[float]
    channels: dict[str, ChannelCompile]
    ignored: list[str] = Field(default=[], description="Requested settings the bridge didn't write, with why")
    warnings: list[str] = []
    file: FileRef


class ApplyResult(CompileResult):
    applied: bool
    manual: bool = Field(description="True: automation unavailable, import file.url yourself")
    verified: bool | None = None
    mismatches: list[str] = []
    backup_id: str | None = None
    message: str | None = None


class RestoreRequest(_Strict):
    to: Literal["last-tune", "baseline"] = "last-tune"
