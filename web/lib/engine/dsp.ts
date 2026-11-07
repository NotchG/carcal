/**
 * Numeric building blocks shared by the engine: the frequency grid, interpolation,
 * fractional-octave smoothing and RBJ biquad magnitude responses.
 * Mirrors carcal/calib/curves.py and carcal/rew_filters.py.
 */

export const PPO = 48;
const N = Math.floor(Math.log2(1000) * PPO) + 1; // 479 points, 20 Hz – 20 kHz
export const GRID: Float64Array = Float64Array.from({ length: N }, (_, i) => 20 * Math.pow(1000, i / (N - 1)));
export const LOG_GRID: Float64Array = GRID.map((f) => Math.log10(f));

export type Vec = Float64Array;
export const vec = (n = N) => new Float64Array(n);
export const fromArray = (a: ArrayLike<number>) => Float64Array.from(a);

/** np.interp: piecewise-linear, clamped at the ends. xp must be increasing. */
export function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}

/** Resample any (freq, dB) data onto GRID, interpolating on log frequency. */
export function toGrid(freqs: ArrayLike<number>, spl: ArrayLike<number>): Vec {
  const pairs = Array.from(freqs, (f, i) => [f, spl[i]] as const).filter(([f]) => f > 0).sort((a, b) => a[0] - b[0]);
  const xp = pairs.map(([f]) => Math.log10(f));
  const fp = pairs.map(([, s]) => s);
  return LOG_GRID.map((lf) => interp(lf, xp, fp));
}

/** Fractional-octave smoothing in the power domain (per-point width allowed). */
export function smooth(spl: Vec, frac: number | Vec): Vec {
  const n = spl.length;
  const csum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) csum[i + 1] = csum[i] + Math.pow(10, spl[i] / 10);
  const out = vec(n);
  for (let i = 0; i < n; i++) {
    const fr = typeof frac === "number" ? frac : frac[i];
    const half = Math.max(1, Math.round((fr * PPO) / 2));
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    out[i] = 10 * Math.log10((csum[hi] - csum[lo]) / (hi - lo));
  }
  return out;
}

export type FilterType = "PK" | "LS" | "HS" | "LSC" | "HSC";
export interface Filter { type: FilterType; fc_hz: number; gain_db: number; q?: number | null }

interface Coefs { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

function coefs(f: Filter, fs: number): Coefs {
  const A = Math.pow(10, f.gain_db / 40);
  const w0 = (2 * Math.PI * f.fc_hz) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  if (f.type === "PK") {
    const alpha = sw / (2 * (f.q || 1));
    return { b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A };
  }
  const q = f.q || 1 / Math.SQRT2;
  const alpha = sw / (2 * q);
  const sa = 2 * Math.sqrt(A) * alpha;
  if (f.type.startsWith("L")) {
    return {
      b0: A * ((A + 1) - (A - 1) * cw + sa), b1: 2 * A * ((A - 1) - (A + 1) * cw), b2: A * ((A + 1) - (A - 1) * cw - sa),
      a0: (A + 1) + (A - 1) * cw + sa, a1: -2 * ((A - 1) + (A + 1) * cw), a2: (A + 1) + (A - 1) * cw - sa,
    };
  }
  return {
    b0: A * ((A + 1) + (A - 1) * cw + sa), b1: -2 * A * ((A - 1) + (A + 1) * cw), b2: A * ((A + 1) + (A - 1) * cw - sa),
    a0: (A + 1) - (A - 1) * cw + sa, a1: 2 * ((A - 1) - (A + 1) * cw), a2: (A + 1) - (A - 1) * cw - sa,
  };
}

/** Precomputed cos/sin of ω and 2ω for a frequency list at one sample rate. */
export class Trig {
  c1: Vec; s1: Vec; c2: Vec; s2: Vec;
  constructor(public freqs: ArrayLike<number>, public fs: number) {
    const n = freqs.length;
    this.c1 = vec(n); this.s1 = vec(n); this.c2 = vec(n); this.s2 = vec(n);
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * freqs[i]) / fs;
      this.c1[i] = Math.cos(w); this.s1[i] = Math.sin(w); this.c2[i] = Math.cos(2 * w); this.s2[i] = Math.sin(2 * w);
    }
  }
}

/** Add one filter's dB response into `out` (z = e^{-jω}). */
export function addResponse(out: Vec, f: Filter, t: Trig): void {
  if (!f.gain_db) return;
  const { b0, b1, b2, a0, a1, a2 } = coefs(f, t.fs);
  for (let i = 0; i < out.length; i++) {
    const nr = b0 + b1 * t.c1[i] + b2 * t.c2[i], ni = -(b1 * t.s1[i] + b2 * t.s2[i]);
    const dr = a0 + a1 * t.c1[i] + a2 * t.c2[i], di = -(a1 * t.s1[i] + a2 * t.s2[i]);
    out[i] += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

export function responseDb(filters: Filter[], t: Trig): Vec {
  const out = vec(t.freqs.length);
  for (const f of filters) addResponse(out, f, t);
  return out;
}

const trigCache = new Map<number, Trig>();
/** Trig for GRID at a sample rate (cached). */
export function gridTrig(fs: number): Trig {
  let t = trigCache.get(fs);
  if (!t) { t = new Trig(GRID, fs); trigCache.set(fs, t); }
  return t;
}

/** numpy.percentile with linear interpolation. */
export function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = (q / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const roundVec = (v: ArrayLike<number>, d = 2) => Array.from(v, (x) => round(x, d));
