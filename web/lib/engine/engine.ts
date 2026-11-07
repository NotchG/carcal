/**
 * Per-speaker EQ from stored measurements, following CAT-BUG. Mirrors
 * carcal/calib/engine.py (checked by golden tests):
 *
 * 1. Smooth the measurement psychoacoustically (6.6).
 * 2. Individual target = house curve + tone + ideal LR4 slopes at the crossovers (5.3.8).
 * 3. Target level placed so the EQ is mostly cuts (6.5); left/right share a level (7).
 * 4. Correction from one octave below the HPF to one above the LPF (6.5); boosts only
 *    for broad dips, never into narrow cancellations (6.4).
 * 5. Design filters within the device's EQ capability; predict the result as heard.
 */
import { Filter, GRID, Vec, percentile, round, roundVec, smooth } from "./dsp";
import { Role, TargetSpec, lr4Db, psychoFraction, systemDb } from "./curves";
import { EqCaps, fitEq } from "./fit";

export const SPEED_OF_SOUND_CM_PER_MS = 34.3;

export interface ChannelDef {
  key: string;
  label: string;
  role: Role;
  pair: string | null;
  hp_hz: number | null;
  lp_hz: number | null;
  level_offset_db: number;
  distance_cm: number | null;
}

export interface CalSettings { max_boost_db: number; max_cut_db: number }

export interface ChannelResult {
  key: string;
  filters: Filter[];
  f_lo: number;
  f_hi: number;
  level_db: number;
  natural_level_db: number;
  deficit_db: number;
  rms_error_db: number;
  max_error_db: number;
  measured: number[];
  target: number[];
  predicted: number[];
  eq_curve: number[];
  notes: string[];
}

export interface Computed {
  freqs: number[];
  system_target: number[];
  system_estimate: number[];
  reference_level_db: number;
  channels: Record<string, ChannelResult>;
  delays_ms: Record<string, number>;
}

const BOOST_SHARE = 0.35;
const MAX_FIT_ERROR = 2.0;

const range = (c: ChannelDef): [number, number] =>
  [Math.max(20, c.hp_hz ? c.hp_hz / 2 : 20), Math.min(20000, c.lp_hz ? c.lp_hz * 2 : 20000)];

function passband(c: ChannelDef): boolean[] {
  const lo = c.hp_hz || 20;
  let hi = c.lp_hz || 20000;
  if (c.role !== "sub") hi = Math.min(hi, 16000);
  return Array.from(GRID, (f) => f >= lo && f <= hi);
}

function shapeOf(c: ChannelDef, sys: Vec): Vec {
  const xo = lr4Db(c.hp_hz, c.lp_hz);
  return sys.map((v, i) => v + xo[i]);
}

export function naturalLevel(c: ChannelDef, measured: Vec, sys: Vec): number {
  const shape = shapeOf(c, sys), m = smooth(measured, 1 / 2), pb = passband(c);
  const d: number[] = [];
  for (let i = 0; i < GRID.length; i++) if (pb[i]) d.push(m[i] - shape[i]);
  return percentile(d, BOOST_SHARE * 100);
}

/** Deep narrow dips (cancellations): 1/24-oct trace well below the 1/2-oct average. */
function narrowDips(measured: Vec, rng: boolean[]): { mask: boolean[]; notes: string[] } {
  const light = smooth(measured, 1 / 24), broad = smooth(measured, 1 / 2);
  const core = Array.from(GRID, (_, i) => broad[i] - light[i] > 5 && rng[i]);
  const mask = [...core];
  for (let s = 1; s < 5; s++) for (let i = 0; i < core.length; i++) {
    if (core[i]) { if (i + s < mask.length) mask[i + s] = true; if (i - s >= 0) mask[i - s] = true; }
  }
  const notes: string[] = [];
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue;
    let j = i;
    while (j + 1 < core.length && core[j + 1]) j++;
    let k = i;
    for (let m = i; m <= j; m++) if (light[m] < light[k]) k = m;
    notes.push(`Narrow dip at ${GRID[k].toFixed(0)} Hz left alone (a cancellation: boosting it wastes power)`);
    i = j;
  }
  return { mask, notes: notes.slice(0, 4) };
}

export function computeChannel(c: ChannelDef, measured: Vec, sys: Vec, level: number,
                               settings: CalSettings, caps: EqCaps, noise?: Vec | null): ChannelResult {
  const notes: string[] = [];
  const shape = shapeOf(c, sys);
  const tgt = shape.map((v) => v + level);
  const frac = psychoFraction(c.role);
  const mFine = smooth(measured, frac), mCoarse = smooth(measured, 1 / 2);
  const [fLo, fHi] = range(c);
  const rng = Array.from(GRID, (f) => f >= fLo && f <= fHi);
  const dips = narrowDips(measured, rng);
  notes.push(...dips.notes);

  const corr = new Float64Array(GRID.length);
  for (let i = 0; i < GRID.length; i++) {
    const cf = tgt[i] - mFine[i], cc = tgt[i] - mCoarse[i];
    let v = cf > 0 ? Math.min(cf, cc) : cf;
    if (dips.mask[i]) v = Math.min(v, 0);
    v = Math.min(settings.max_boost_db, Math.max(-settings.max_cut_db, v));
    corr[i] = rng[i] ? v : 0;
  }

  const fit = fitEq(corr, caps, { fLo, fHi, maxBoost: settings.max_boost_db, maxCut: settings.max_cut_db, perceptual: frac });
  const heard = measured.map((v, i) => v + fit.response[i]);
  const predicted = smooth(heard, frac);
  const pb = passband(c);
  const err: number[] = [], errIdx: number[] = [];
  for (let i = 0; i < GRID.length; i++) if (pb[i]) { err.push(predicted[i] - tgt[i]); errIdx.push(i); }
  const maxErr = Math.max(...err.map(Math.abs));

  // Explain the biggest remaining miss by its cause (narrow dips have their own note).
  let k = -1, kv = 0;
  err.forEach((e, n) => { const v = dips.mask[errIdx[n]] ? 0 : e; if (Math.abs(v) > Math.abs(kv)) { kv = v; k = n; } });
  if (k >= 0 && Math.abs(kv) > MAX_FIT_ERROR) {
    const i = errIdx[k], fK = GRID[i].toFixed(0);
    const wanted = tgt[i] - mFine[i];
    if (kv < 0 && wanted > settings.max_boost_db) {
      notes.push(`${(-kv).toFixed(1)} dB under target around ${fK} Hz: it would need more than the ${settings.max_boost_db} dB boost limit (EQ limits)`);
    } else if (kv > 0) {
      notes.push(`${kv.toFixed(1)} dB over target around ${fK} Hz: the DSP's EQ can't cut that area cleanly`);
    } else {
      notes.push(`${(-kv).toFixed(1)} dB under target around ${fK} Hz`);
    }
  }
  if (noise) {
    const d = errIdx.map((i) => measured[i] - noise[i]).sort((a, b) => a - b);
    const snr = d[Math.floor(d.length / 2)];
    if (snr < 20) notes.push(`Measurement only ${snr.toFixed(0)} dB above the noise floor (CAT-BUG asks for 20+). Re-measure louder if results look odd.`);
  }

  return {
    key: c.key, filters: fit.filters.filter((f) => f.gain_db !== 0), f_lo: fLo, f_hi: fHi,
    level_db: level, natural_level_db: 0, deficit_db: 0,
    rms_error_db: Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length), max_error_db: maxErr,
    measured: roundVec(mFine), target: roundVec(tgt), predicted: roundVec(predicted),
    eq_curve: roundVec(fit.response), notes,
  };
}

const psum = (arrays: number[][]) =>
  arrays[0].map((_, i) => round(10 * Math.log10(arrays.reduce((s, a) => s + 10 ** (a[i] / 10), 0))));

export function delaysMs(channels: ChannelDef[]): Record<string, number> {
  const d = channels.filter((c) => c.distance_cm);
  if (!d.length) return {};
  const far = Math.max(...d.map((c) => c.distance_cm!));
  return Object.fromEntries(d.map((c) => [c.key, round((far - c.distance_cm!) / SPEED_OF_SOUND_CM_PER_MS, 3)]));
}

export function computeAll(channels: ChannelDef[], measurements: Record<string, Vec>, target: TargetSpec,
                           settings: CalSettings, caps: EqCaps, noise?: Vec | null): Computed {
  const sys = systemDb(target);
  const measured = channels.filter((c) => measurements[c.key]);
  const nat: Record<string, number> = {};
  for (const c of measured) nat[c.key] = naturalLevel(c, measurements[c.key], sys);
  const fronts = measured.filter((c) => c.role === "front");
  const refSet = fronts.length ? fronts : measured.slice(0, 1);
  const ref = refSet.length ? Math.min(...refSet.map((c) => nat[c.key])) : 0;

  const results: Record<string, ChannelResult> = {};
  for (const c of measured) {
    const want = ref + c.level_offset_db;
    const reachable = nat[c.key] + settings.max_boost_db * 0.5;
    const deficit = Math.max(0, want - reachable);
    const r = computeChannel(c, measurements[c.key], sys, want - deficit, settings, caps, noise);
    r.natural_level_db = nat[c.key];
    r.deficit_db = round(deficit, 1);
    if (deficit > 0.5) {
      r.notes.push(`${deficit.toFixed(1)} dB quieter than the target balance. EQ can't make that up: raise this channel's level/amp gain by about ${deficit.toFixed(0)} dB, then re-measure.`);
    }
    results[c.key] = r;
  }
  for (const c of measured) {
    if (c.pair && results[c.pair] && results[c.pair].deficit_db > results[c.key].deficit_db) {
      const drop = results[c.pair].deficit_db - results[c.key].deficit_db;
      const keep = results[c.key].deficit_db;
      const r = computeChannel(c, measurements[c.key], sys, results[c.key].level_db - drop, settings, caps, noise);
      r.natural_level_db = nat[c.key];
      r.deficit_db = keep;
      r.notes.push(`Lowered ${drop.toFixed(1)} dB to stay level-matched with ${c.pair}`);
      results[c.key] = r;
    }
  }
  const rs = Object.values(results);
  return {
    freqs: roundVec(GRID, 2),
    system_target: rs.length ? psum(rs.map((r) => r.target)) : [],
    system_estimate: rs.length ? psum(rs.map((r) => r.predicted)) : [],
    reference_level_db: round(ref),
    channels: results,
    delays_ms: delaysMs(measured),
  };
}

/** REW's "filter settings as text" format, which the bridge (and REW) can read. */
export function toRewTxt(filters: Filter[], note = "carcal"): string {
  const lines = ["Filter Settings file", "", "Room EQ V5.40", `Notes:${note}`, "", "Equaliser: Generic"];
  filters.forEach((f, i) => {
    const fc = f.fc_hz >= 1000 ? f.fc_hz.toFixed(0) : f.fc_hz.toFixed(1);
    const q = f.q ? `  Q  ${f.q.toFixed(3)}` : "";
    lines.push(`Filter ${String(i + 1).padStart(2)}: ON  ${f.type.padEnd(4)}     Fc   ${fc} Hz  Gain  ${f.gain_db.toFixed(2)} dB${q}`);
  });
  return lines.join("\n") + "\n";
}
