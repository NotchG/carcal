import json
import warnings
from pathlib import Path

import numpy as np
import pytest

from carcal.dsp_codec import Preset, SpecError, diff, dumps
from carcal.eq_fit import fit_31band, fit_from_rew
from carcal.rew_filters import Filter, log_grid, parse_file, response_db
from carcal.spec import DEFAULT_SPEC, ISO_31

HERE = Path(__file__).parent
SAMPLE = HERE.parent / "samples_wuling.dspSingle"
REW = HERE / "sample_rew_filters.txt"

warnings.simplefilter("ignore")


def test_roundtrip_byte_identical():
    p = Preset.load(SAMPLE)
    assert p.roundtrip_ok()
    assert p.to_bytes() == SAMPLE.read_bytes()


def test_edit_touches_only_requested_fields():
    p = Preset.load(SAMPLE)
    orig = json.loads(SAMPLE.read_bytes())
    p.set_band_gain("FL", 24, -4.0)
    changes = diff(orig, p.data)
    assert changes == [("outPuts.outPut[0].EQ[24].level", 570, 560)]


def test_edit_then_revert_is_identical():
    p = Preset.load(SAMPLE)
    p.set_band_gain("FR", 10, +2.0)
    p.set_band_raw("FR", 10, level=585)
    assert p.to_bytes() == SAMPLE.read_bytes()


def test_groups_resolve():
    p = Preset.load(SAMPLE)
    assert p.resolve("SUB") == [4, 5]
    assert p.resolve(["FL", "RR"]) == [0, 3]


def test_solo_mutes_others_and_flattens():
    p = Preset.load(SAMPLE)
    s = p.solo("FL")
    assert [o["mute"] for o in s.outputs] == [1, 0, 0, 0, 0, 0]
    assert all(b["level"] == 600 for b in s.outputs[0]["EQ"])
    # crossovers kept, other channels' EQ untouched, source untouched
    assert s.outputs[0]["hFreq"] == p.outputs[0]["hFreq"]
    assert s.outputs[1]["EQ"] == p.outputs[1]["EQ"]
    assert p.outputs[1]["mute"] == 1
    sub = p.solo("SUB")
    assert [o["mute"] for o in sub.outputs] == [0, 0, 0, 0, 1, 1]


def test_unknown_units_refuse():
    p = Preset.load(SAMPLE)
    with pytest.raises(SpecError):
        p.set_delay_ms("FL", 1.0)


def test_strict_mode_refuses_assumed():
    p = Preset.load(SAMPLE, strict=True)
    with pytest.raises(SpecError):
        p.set_band_gain("FL", 0, -1.0)


def test_validate_rejects_bad_band_count(tmp_path):
    d = json.loads(SAMPLE.read_bytes())
    d["outPuts"]["outPut"][0]["EQ"].pop()
    f = tmp_path / "bad.dspSingle"
    f.write_bytes(dumps(d))
    with pytest.raises(ValueError):
        Preset.load(f)


CLEAN = HERE.parent / "samples_clean_default.dspSingle"


def test_clean_default_roundtrip():
    assert Preset.load(CLEAN).roundtrip_ok()


def test_probes_change_only_planned_fields(tmp_path):
    from carcal.probes import PROBES, write_all
    base = Preset.load(CLEAN)
    write_all(base, tmp_path)
    for pr in PROBES:
        got = Preset.load(tmp_path / f"probe_{pr.id}.dspSingle")
        changed = {path for path, _, _ in diff(base.data, got.data)}
        expected = set()
        for s in pr.settings:
            (i,) = base.resolve(s.channel)
            if s.field.startswith("EQ["):
                band, key = s.field[3:s.field.index("]")], s.field.split(".", 1)[1]
                path = f"outPuts.outPut[{i}].EQ[{band}].{key}"
                default = base.outputs[i]["EQ"][int(band)][key]
            else:
                path = f"outPuts.outPut[{i}].{s.field}"
                default = base.outputs[i][s.field]
            if s.raw != default:          # settings equal to the default are controls
                expected.add(path)
            else:
                assert "control" in s.note, (pr.id, s)
        assert changed == expected, (pr.id, changed ^ expected)
    assert (tmp_path / "PROBE_CHECKLIST.md").exists()


def test_parse_rew_text():
    fs = parse_file(REW)
    assert [f.type for f in fs] == ["PK", "PK", "PK", "HSC", "PK"]
    assert fs[0].fc == 125 and fs[0].gain_db == -5 and fs[0].q == 2.5
    assert fs[4].fc == 1250 and abs(fs[4].q - 4.318) < 0.01


def test_peaking_response_peak():
    f = log_grid()
    r = response_db([Filter("PK", 1000, -6, 2.0)], f)
    assert abs(r[np.argmin(abs(f - 1000))] + 6) < 0.05


def test_fit_matches_iso_band_exactly():
    # A target built from the DSP's own bands must be reproduced almost exactly.
    f = log_grid()
    q = DEFAULT_SPEC.bw_to_q[14]
    target = response_db([Filter("PK", 250, -4, q), Filter("PK", 1000, 2, q)], f)
    res = fit_31band(target, f, f_lo=60, f_hi=16000)
    assert res.max_err_db < 0.3
    assert abs(res.gains_db[ISO_31.index(250)] + 4) < 0.3


def test_fit_from_rew_reasonable():
    res = fit_from_rew(parse_file(REW), f_lo=70, f_hi=12000)
    assert res.rms_err_db < 0.7
    assert len(res.gains_db) == 31
    assert all(g <= 3.0 for g in res.gains_db)
    # nothing outside the fit range is touched
    assert res.gains_db[0] == 0 and res.gains_db[-1] == 0
