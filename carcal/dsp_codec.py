"""Read, patch and write EL-PA4.6 `.dspSingle` presets without losing anything.

Design rules
  * Never build a preset from scratch: always load a real export and patch it.
  * Only touch the keys you ask to change; every other key (including the
    unexplained ones like none2, IN17Vol..IN20Vol, Pawss) is written back as-is.
  * Output is compact JSON with the original key order, so an unmodified
    load -> save is byte-identical to the input (checked by `roundtrip_ok`).
"""

from __future__ import annotations

import copy
import json
import warnings
from pathlib import Path
from typing import Any, Iterable

from .spec import (ASSUMED, DEFAULT_CHANNEL_MAP, DEFAULT_GROUPS, DEFAULT_SPEC,
                   ISO_31, N_BANDS, UNKNOWN, DeviceSpec)


class SpecError(RuntimeError):
    """A conversion was requested for a field whose units are not known yet."""


def _check(status: str, what: str, strict: bool) -> None:
    if status == UNKNOWN:
        raise SpecError(f"{what}: units unknown - set the raw value instead, or confirm "
                        f"the unit with a controlled export and update spec.py")
    if status == ASSUMED:
        msg = f"{what}: using an ASSUMED unit conversion (see FORMAT.md)"
        if strict:
            raise SpecError(msg)
        warnings.warn(msg, stacklevel=3)


def dumps(data: dict) -> bytes:
    """Serialise exactly like the DSP app: compact, no spaces, original key order."""
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Preset:
    def __init__(self, data: dict, spec: DeviceSpec = DEFAULT_SPEC,
                 channel_map: dict[str, int] | None = None,
                 groups: dict[str, list[str]] | None = None,
                 strict: bool = False, source: bytes | None = None):
        self.data = data
        self.spec = spec
        self.channel_map = dict(channel_map or DEFAULT_CHANNEL_MAP)
        self.groups = dict(groups or DEFAULT_GROUPS)
        self.strict = strict          # strict=True turns ASSUMED conversions into errors
        self._source = source

    # ---------- I/O ----------
    @classmethod
    def load(cls, path: str | Path, **kw) -> "Preset":
        raw = Path(path).read_bytes()
        if raw.startswith(b"\xef\xbb\xbf"):
            raise ValueError("file has a UTF-8 BOM; the sample export did not - check the source")
        p = cls(json.loads(raw), source=raw, **kw)
        p.validate()
        return p

    def to_bytes(self) -> bytes:
        return dumps(self.data)

    def save(self, path: str | Path) -> Path:
        self.validate()
        path = Path(path)
        path.write_bytes(self.to_bytes())
        return path

    def roundtrip_ok(self) -> bool:
        """True if the untouched file re-serialises byte-for-byte."""
        return self._source is not None and dumps(json.loads(self._source)) == self._source

    def copy(self) -> "Preset":
        return Preset(copy.deepcopy(self.data), self.spec, self.channel_map,
                      self.groups, self.strict, self._source)

    # ---------- structure ----------
    @property
    def info(self) -> dict:
        return self.data["info"]

    @property
    def outputs(self) -> list[dict]:
        return self.data["outPuts"]["outPut"]

    def resolve(self, channels: str | int | Iterable[str | int]) -> list[int]:
        """'FL' -> [0]; 'SUB' -> [4, 5]; 3 -> [3]; ['FL','RR'] -> [0, 3]."""
        if isinstance(channels, (str, int)):
            channels = [channels]
        idx: list[int] = []
        for c in channels:
            if isinstance(c, int):
                idx.append(c)
            elif c in self.groups:
                idx.extend(self.channel_map[m] for m in self.groups[c])
            elif c in self.channel_map:
                idx.append(self.channel_map[c])
            else:
                raise KeyError(f"unknown channel or group {c!r}")
        return sorted(set(idx))

    def name_of(self, index: int) -> str:
        for k, v in self.channel_map.items():
            if v == index:
                return k
        return f"out{index + 1}"

    def validate(self) -> None:
        info = self.info
        if info.get("FileType") != "single":
            raise ValueError(f"unexpected FileType {info.get('FileType')!r}")
        outs = self.outputs
        for i, o in enumerate(outs):
            eq = o["EQ"]
            if len(eq) != N_BANDS:
                raise ValueError(f"out{i+1}: {len(eq)} EQ bands, expected {N_BANDS}")
            for b in eq:
                for k in ("freq", "level", "bw", "shfDb", "type"):
                    if not isinstance(b.get(k), int):
                        raise ValueError(f"out{i+1}: band field {k} must be int, got {b.get(k)!r}")
            for k in ("mute", "polar", "gain", "delay", "hFreq", "lFreq", "hFilter",
                      "hLevel", "lFilter", "lLevel"):
                if not isinstance(o.get(k), int):
                    raise ValueError(f"out{i+1}: {k} must be int, got {o.get(k)!r}")
            if not (20 <= o["hFreq"] <= 20000 and 20 <= o["lFreq"] <= 20000):
                raise ValueError(f"out{i+1}: crossover frequency out of 20..20000 Hz")

    # ---------- raw setters (always allowed) ----------
    def set_raw(self, channels, key: str, value: int) -> None:
        for i in self.resolve(channels):
            if key not in self.outputs[i]:
                raise KeyError(f"out{i+1} has no key {key!r}")
            self.outputs[i][key] = int(value)

    def set_band_raw(self, channels, band: int, **fields: int) -> None:
        for i in self.resolve(channels):
            b = self.outputs[i]["EQ"][band]
            for k, v in fields.items():
                if k not in b:
                    raise KeyError(f"band has no key {k!r}")
                b[k] = int(v)

    # ---------- unit-aware setters ----------
    def db_to_level(self, db: float) -> int:
        s = self.spec
        db = max(s.eq_gain_min_db, min(s.eq_gain_max_db, db))
        return int(round(s.eq_level_offset + db * s.eq_level_per_db))

    def level_to_db(self, level: int) -> float:
        s = self.spec
        return (level - s.eq_level_offset) / s.eq_level_per_db

    def set_band_gain(self, channels, band: int, gain_db: float) -> None:
        _check(self.spec.eq_level_status, "EQ level", self.strict)
        self.set_band_raw(channels, band, level=self.db_to_level(gain_db))

    def set_eq_gains(self, channels, gains_db: list[float]) -> None:
        """Write all 31 band gains (dB) for the given channels."""
        if len(gains_db) != N_BANDS:
            raise ValueError(f"need {N_BANDS} gains, got {len(gains_db)}")
        _check(self.spec.eq_level_status, "EQ level", self.strict)
        for i in self.resolve(channels):
            for b, g in zip(self.outputs[i]["EQ"], gains_db):
                b["level"] = self.db_to_level(g)

    def get_eq_gains(self, channel) -> list[float]:
        (i,) = self.resolve(channel)
        return [self.level_to_db(b["level"]) for b in self.outputs[i]["EQ"]]

    def flatten_eq(self, channels) -> None:
        for i in self.resolve(channels):
            for b in self.outputs[i]["EQ"]:
                b["level"] = self.spec.eq_level_offset

    def set_mute(self, channels, muted: bool) -> None:
        _check(self.spec.mute_status, "mute", self.strict)
        v = self.spec.mute_muted_value if muted else self.spec.mute_active_value
        self.set_raw(channels, "mute", v)

    def set_polarity(self, channels, inverted: bool) -> None:
        _check(self.spec.polarity_status, "polarity", self.strict)
        self.set_raw(channels, "polar", 1 if inverted else 0)

    def set_delay_ms(self, channels, ms: float) -> None:
        s = self.spec
        _check(s.delay_status, "delay", self.strict)
        if s.delay_unit == "samples48k":
            raw = ms * 48.0
        elif s.delay_unit == "ms_0.01":
            raw = ms * 100.0
        elif s.delay_unit == "ms_0.1":
            raw = ms * 10.0
        elif s.delay_unit == "cm":
            raw = ms * 34.3
        else:
            raise SpecError(f"unsupported delay_unit {s.delay_unit!r}")
        self.set_raw(channels, "delay", int(round(raw)))

    def set_crossover(self, channels, *, hp_hz: int | None = None, hp_type: int | None = None,
                      hp_slope_code: int | None = None, lp_hz: int | None = None,
                      lp_type: int | None = None, lp_slope_code: int | None = None) -> None:
        """Codes are raw (see spec.filter_types / slope_db_per_oct)."""
        _check(self.spec.xover_status, "crossover codes", self.strict)
        for i in self.resolve(channels):
            o = self.outputs[i]
            for key, val in (("hFreq", hp_hz), ("hFilter", hp_type), ("hLevel", hp_slope_code),
                             ("lFreq", lp_hz), ("lFilter", lp_type), ("lLevel", lp_slope_code)):
                if val is not None:
                    o[key] = int(val)

    # ---------- measurement presets ----------
    def solo(self, channels, *, flatten_eq: bool = True, keep_crossovers: bool = True,
             zero_delay: bool = False) -> "Preset":
        """Copy with only `channels` playing - for per-speaker RTA captures.

        CAT-BUG measures each driver alone with EQ bypassed. Crossovers are kept
        by default because the fronts' midbass and the sub need their protective
        filters even during measurement.
        """
        p = self.copy()
        keep = set(p.resolve(channels))
        for i in range(len(p.outputs)):
            p.set_mute(i, muted=i not in keep)
        if flatten_eq:
            p.flatten_eq(sorted(keep))
        if not keep_crossovers:
            for i in keep:
                p.outputs[i]["hFreq"], p.outputs[i]["lFreq"] = 20, 20000
        if zero_delay:
            p.set_raw(sorted(keep), "delay", 0)
        return p

    # ---------- reporting ----------
    def summary(self) -> str:
        s = self.spec
        lines = [f"{self.info.get('DeviceName')}  fw {self.info.get('McuVersion')}  "
                 f"type {self.info.get('FileType')}  outputs {len(self.outputs)}"]
        for i, o in enumerate(self.outputs):
            ft = s.filter_types
            sl = s.slope_db_per_oct
            hp = "off" if sl.get(o["hLevel"], 0) is None else \
                f"{o['hFreq']}Hz {ft.get(o['hFilter'], o['hFilter'])} {sl.get(o['hLevel'])}dB/oct"
            lp = "off" if sl.get(o["lLevel"], 0) is None else \
                f"{o['lFreq']}Hz {ft.get(o['lFilter'], o['lFilter'])} {sl.get(o['lLevel'])}dB/oct"
            eq = [(b["freq"], self.level_to_db(b["level"])) for b in o["EQ"]
                  if b["level"] != s.eq_level_offset]
            eqs = ", ".join(f"{f}Hz {g:+.1f}" for f, g in eq) or "flat"
            state = "on" if o["mute"] == s.mute_active_value else "MUTED"
            lines.append(
                f"  {self.name_of(i):6} out{i+1} [{state}] pol={'inv' if o['polar'] else 'norm'} "
                f"gain={o['gain']}(raw) delay={o['delay']}(raw)  HP {hp} | LP {lp}\n"
                f"           EQ: {eqs}")
        return "\n".join(lines)


def diff(a: Any, b: Any, path: str = "") -> list[tuple[str, Any, Any]]:
    """Every leaf that differs between two parsed presets."""
    out: list[tuple[str, Any, Any]] = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(a) + [k for k in b if k not in a]:
            out += diff(a.get(k, "<missing>"), b.get(k, "<missing>"), f"{path}.{k}" if path else k)
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            out += diff(a[i] if i < len(a) else "<missing>",
                        b[i] if i < len(b) else "<missing>", f"{path}[{i}]")
    elif a != b:
        out.append((path, a, b))
    return out


def describe_path(path: str, channel_map: dict[str, int] = DEFAULT_CHANNEL_MAP) -> str:
    """outPuts.outPut[1].EQ[24].level -> 'FR (out2) EQ band 25 @5000Hz .level'."""
    import re
    m = re.match(r"outPuts\.outPut\[(\d+)\]\.?(.*)", path)
    if not m:
        return path
    i, rest = int(m.group(1)), m.group(2)
    name = next((k for k, v in channel_map.items() if v == i), f"out{i+1}")
    m2 = re.match(r"EQ\[(\d+)\]\.(\w+)", rest)
    if m2:
        b = int(m2.group(1))
        rest = f"EQ band {b+1} @{ISO_31[b]}Hz .{m2.group(2)}"
    return f"{name} (out{i+1}) {rest}"
