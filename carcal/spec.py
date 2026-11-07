"""Field meanings and unit conversions for the EL-PA4.6 (DSP-680-31EQ-V3.0) preset file.

Every conversion carries a status:
  CONFIRMED - follows directly from the file structure
  ASSUMED   - best guess; must be verified with a controlled export (see FORMAT.md)
  UNKNOWN   - no basis for a guess; only raw values may be written

Code that converts physical units into raw values refuses to run on an UNKNOWN
field, and warns on an ASSUMED one, so a wrong guess can never slip silently
into a preset you load into the amp.
"""

from __future__ import annotations

from dataclasses import dataclass, field


CONFIRMED, ASSUMED, UNKNOWN = "confirmed", "assumed", "unknown"

# The 31 ISO 1/3-octave centre frequencies stored in every output's EQ array.
ISO_31 = [20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
          630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
          10000, 12500, 16000, 20000]

N_OUTPUTS = 6
N_BANDS = 31


@dataclass
class DeviceSpec:
    """Unit conversions. Edit these once the controlled exports confirm them."""

    # EQ band level: raw = offset + dB * per_db.  600 == 0 dB is CONFIRMED (every
    # untouched band is 600); 0.1 dB steps are ASSUMED from values like 585/570/606.
    eq_level_offset: int = 600
    eq_level_per_db: float = 10.0
    eq_level_status: str = ASSUMED
    eq_gain_min_db: float = -12.0   # conservative clamp until the app's range is known
    eq_gain_max_db: float = 12.0

    # Band bandwidth code -> Q.  Code 14 shows as Q 7.613 in the app (screenshot of
    # the clean default). Other codes: probe 03.
    bw_to_q: dict[int, float] = field(default_factory=lambda: {14: 7.613})
    bw_status: str = CONFIRMED

    # Can a band's 'freq' be moved off its ISO centre (true PEQ)?  Unknown.
    band_freq_adjustable: bool = False
    band_freq_status: str = UNKNOWN

    # 'mute': every output plays in the sample and all read 1, so 1 = active.
    mute_active_value: int = 1
    mute_muted_value: int = 0
    mute_status: str = ASSUMED

    # 'polar': 0 normal, 1 inverted (sub outputs are 1).
    polarity_status: str = ASSUMED

    # 'delay': raw units unknown (samples @48k? 0.01 ms? cm?).
    delay_unit: str | None = None          # set to "samples48k", "ms_0.01", "cm", ...
    delay_status: str = UNKNOWN

    # 'gain': channel gain. 60 shows as 0dB (confirmed, and it is the slider's top);
    # the step size below 0 dB is unknown until probe 06.
    gain_raw_for_0db: int | None = 60
    gain_per_db: float | None = None
    gain_status: str = UNKNOWN

    # Crossover filter type and slope codes. Confirmed from the app: type 2 shows
    # "Butter_W", slope 3 shows "24dB/Oct", slope 8 shows "OFF". The rest: probe 08.
    filter_types: dict[int, str] = field(
        default_factory=lambda: {0: "type0?", 1: "type1?", 2: "Butterworth"})
    slope_db_per_oct: dict[int, int | None] = field(
        default_factory=lambda: {0: 6, 1: 12, 2: 18, 3: 24, 4: 30, 5: 36, 6: 42, 7: 48, 8: None})
    xover_status: str = ASSUMED   # only codes 2 / 3 / 8 are confirmed

    # Assumed internal sample rate for filter simulation.
    fs: int = 48000


DEFAULT_SPEC = DeviceSpec()

# Channel map (see FORMAT.md). Index = position in outPut[]. Confirmed by the factory
# default: out1-4 take high-level inputs IN1-4 one-to-one, out5/out6 take IN1/IN2 and
# are low-passed.
DEFAULT_CHANNEL_MAP = {
    "FL": 0,
    "FR": 1,
    "RL": 2,
    "RR": 3,
    "SUB_L": 4,
    "SUB_R": 5,
}
DEFAULT_GROUPS = {
    "FRONT": ["FL", "FR"],
    "REAR": ["RL", "RR"],
    "SUB": ["SUB_L", "SUB_R"],
}

# Keys inside each output that are known to be per-output settings.
OUTPUT_KEYS_KNOWN = {
    "EQ", "mute", "polar", "gain", "delay", "polarS",
    "hFreq", "hFilter", "hLevel", "lFreq", "lFilter", "lLevel",
    "AllPassType", "AllPassQ", "AllPassHz", "name",
} | {f"IN{i}Vol" for i in range(1, 21)}
