"""Command line entry point.

  python -m carcal info   preset.dspSingle
  python -m carcal diff   before.dspSingle after.dspSingle
  python -m carcal solo   preset.dspSingle FL      -o measure_FL.dspSingle
  python -m carcal solo-all preset.dspSingle       -o measure_presets/
  python -m carcal apply-rew preset.dspSingle FL rew_FL.txt --lo 70 --hi 12000 -o tuned.dspSingle
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

from .dsp_codec import Preset, describe_path, diff
from .eq_fit import fit_from_rew
from .rew_filters import parse_file


def _warn_fmt(message, category, filename, lineno, line=None):
    return f"warning: {message}\n"


warnings.formatwarning = _warn_fmt


def cmd_info(a):
    p = Preset.load(a.preset)
    print(p.summary())
    print(f"\nround-trip byte-identical: {p.roundtrip_ok()}")


def cmd_diff(a):
    pa, pb = Preset.load(a.a), Preset.load(a.b)
    changes = diff(pa.data, pb.data)
    if not changes:
        print("identical")
        return
    for path, x, y in changes:
        print(f"{describe_path(path, pa.channel_map):55} {x!r:>8} -> {y!r}")
    print(f"\n{len(changes)} field(s) changed")


def cmd_solo(a):
    p = Preset.load(a.preset)
    s = p.solo(a.channels, flatten_eq=not a.keep_eq, keep_crossovers=not a.no_crossovers)
    out = Path(a.output or f"measure_{'_'.join(a.channels)}.dspSingle")
    s.save(out)
    print(f"wrote {out}")
    print(s.summary())


def cmd_solo_all(a):
    p = Preset.load(a.preset)
    outdir = Path(a.output or "measure_presets")
    outdir.mkdir(parents=True, exist_ok=True)
    targets = ["FL", "FR", "RL", "RR", "SUB", "FRONT", "REAR"]
    for t in targets:
        path = outdir / f"measure_{t}.dspSingle"
        p.solo(t, flatten_eq=True, keep_crossovers=True).save(path)
        print(f"wrote {path}")


def cmd_apply_rew(a):
    p = Preset.load(a.preset)
    filters = parse_file(a.rew_file)
    print(f"{len(filters)} REW filter(s):")
    for f in filters:
        print("   ", f)
    fit = fit_from_rew(filters, f_lo=a.lo, f_hi=a.hi, spec=p.spec,
                       max_boost_db=a.max_boost)
    print(fit.report())
    if fit.max_err_db > a.max_err:
        print(f"\nfit error {fit.max_err_db:.2f} dB exceeds --max-err {a.max_err} dB. "
              f"The REW filters are probably narrower than 1/3-octave bands can follow. "
              f"Re-run Match Target with a lower max Q, or raise --max-err.", file=sys.stderr)
        if not a.force:
            sys.exit(2)
    p.set_eq_gains(a.channel, fit.gains_db)
    out = Path(a.output)
    p.save(out)
    print(f"\nwrote {out}")


def cmd_probe(a):
    from .probes import write_all
    base = Preset.load(a.baseline)
    for path in write_all(base, a.output):
        print(f"wrote {path}")


def cmd_probe_review(a):
    """Compare each probe with the copy the app exported back."""
    from .probes import PROBES
    d = Path(a.dir)
    for pr in PROBES:
        sent, back = d / f"probe_{pr.id}.dspSingle", d / f"probe_{pr.id}_back.dspSingle"
        if not back.exists():
            print(f"probe {pr.id} {pr.title}: no _back file")
            continue
        ps, pb = Preset.load(sent), Preset.load(back)
        changes = [c for c in diff(ps.data, pb.data) if not c[0].startswith("system.")
                   and not c[0].startswith("info.")]
        print(f"probe {pr.id} {pr.title}: "
              f"{'app kept every value' if not changes else f'{len(changes)} value(s) changed by the app'}")
        for path, x, y in changes:
            print(f"    {describe_path(path, ps.channel_map):50} sent {x!r:>6} -> saved {y!r}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="carcal")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("info", help="decode and summarise a preset")
    s.add_argument("preset")
    s.set_defaults(func=cmd_info)

    s = sub.add_parser("diff", help="show every field that differs between two presets")
    s.add_argument("a")
    s.add_argument("b")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("solo", help="preset with only the given channels playing")
    s.add_argument("preset")
    s.add_argument("channels", nargs="+", help="FL FR RL RR SUB_L SUB_R or groups FRONT REAR SUB")
    s.add_argument("-o", "--output")
    s.add_argument("--keep-eq", action="store_true", help="don't flatten EQ")
    s.add_argument("--no-crossovers", action="store_true",
                   help="open HP/LP fully (dangerous for midbass/sub - not recommended)")
    s.set_defaults(func=cmd_solo)

    s = sub.add_parser("solo-all", help="write the whole set of measurement presets")
    s.add_argument("preset")
    s.add_argument("-o", "--output", help="output directory")
    s.set_defaults(func=cmd_solo_all)

    s = sub.add_parser("apply-rew", help="fit a REW filter export into a channel's 31-band EQ")
    s.add_argument("preset")
    s.add_argument("channel")
    s.add_argument("rew_file")
    s.add_argument("--lo", type=float, required=True, help="lowest frequency to correct (Hz)")
    s.add_argument("--hi", type=float, required=True, help="highest frequency to correct (Hz)")
    s.add_argument("--max-boost", type=float, default=3.0)
    s.add_argument("--max-err", type=float, default=1.5, help="refuse if fit error exceeds this (dB)")
    s.add_argument("--force", action="store_true")
    s.add_argument("-o", "--output", required=True)
    s.set_defaults(func=cmd_apply_rew)

    s = sub.add_parser("probe", help="write the converter-calibration probe presets")
    s.add_argument("baseline", help="a clean default export")
    s.add_argument("-o", "--output", default="probes")
    s.set_defaults(func=cmd_probe)

    s = sub.add_parser("probe-review", help="diff each probe against the app's re-export")
    s.add_argument("dir", help="folder with probe_NN.dspSingle and probe_NN_back.dspSingle")
    s.set_defaults(func=cmd_probe_review)

    a = ap.parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    main()
