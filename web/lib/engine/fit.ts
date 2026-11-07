/**
 * EQ design within a device's capabilities.
 *  - fixed:      bands at set centres with one Q; solve the gains (bounded least squares).
 *  - parametric: place up to N peaking filters greedily, then refine their gains.
 * The fixed fit mirrors carcal/eq_fit.py fit_31band(perceptual=...): match the smoothed
 * EQ response to the smoothed correction and penalise ripple between narrow bands.
 */
import { Filter, GRID, Trig, Vec, addResponse, interp, vec } from "./dsp";

export interface EqCaps {
  kind: "fixed" | "parametric";
  bands_hz?: number[] | null;
  q?: number | null;
  q_range?: [number, number] | null;
  max_filters: number;
  gain_db: [number, number];
  gain_step_db: number;
  fs_hz: number;
}

export interface FitOptions {
  fLo: number;
  fHi: number;
  maxBoost: number;
  maxCut: number;
  perceptual: Vec;          // smoothing width per GRID point (octaves)
  rippleWeight?: number;
}

export interface FitResult { filters: Filter[]; response: Vec }

const REG = 0.02;

/**
 * Moving average over ±frac/2 octave around each point (dB domain). The window of
 * every row is contiguous on a log grid, so applying it is a prefix-sum lookup (O(N)).
 */
interface Smoother { lo: Int32Array; hi: Int32Array }

function smoothingMatrix(freqs: number[], frac: number[]): Smoother {
  const lf = freqs.map(Math.log2), n = freqs.length;
  const lo = new Int32Array(n), hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let a = i, b = i;
    while (a > 0 && Math.abs(lf[a - 1] - lf[i]) <= frac[i] / 2) a--;
    while (b < n - 1 && Math.abs(lf[b + 1] - lf[i]) <= frac[i] / 2) b++;
    lo[i] = a; hi[i] = b + 1;
  }
  return { lo, hi };
}

const matVec = (S: Smoother, v: ArrayLike<number>) => {
  const n = S.lo.length, cs = new Float64Array(n + 1), out = new Float64Array(n);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + v[i];
  for (let i = 0; i < n; i++) out[i] = (cs[S.hi[i]] - cs[S.lo[i]]) / (S.hi[i] - S.lo[i]);
  return out;
};

/** Solve A x = b (A symmetric positive definite-ish) by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

/**
 * Bounded Levenberg-Marquardt for gains of fixed-shape bands.
 * Each band only moves its own term, so the Jacobian column for band k is
 * d(band_k)/d(g_k), computed by a forward difference on that band alone.
 */
function solveGains(
  shapes: { fc: number; q: number; type: Filter["type"] }[], x0: number[], lo: number, hi: number,
  freqsIn: number[], tIn: number[], fs: number, S: Smoother | null, rippleW: number,
): number[] {
  const trig = new Trig(freqsIn, fs);
  const n = freqsIn.length, k = shapes.length;
  const band = (j: number, g: number) => {
    const out = vec(n);
    addResponse(out, { type: shapes[j].type, fc_hz: shapes[j].fc, gain_db: g, q: shapes[j].q }, trig);
    return out;
  };
  const tS = S ? matVec(S, tIn) : null;

  const residual = (x: number[]) => {
    const b = vec(n);
    for (let j = 0; j < k; j++) { const r = band(j, x[j]); for (let i = 0; i < n; i++) b[i] += r[i]; }
    if (!S) return [...Array.from(b, (v, i) => v - tIn[i]), ...x.map((v) => REG * v)];
    const sb = matVec(S, b);
    return [...Array.from(sb, (v, i) => v - tS![i]), ...Array.from(b, (v, i) => rippleW * (v - sb[i])), ...x.map((v) => REG * v)];
  };
  const jacobian = (x: number[]) => {
    const e = 1e-3, cols: number[][] = [];
    for (let j = 0; j < k; j++) {
      const a = band(j, x[j] + e), b0 = band(j, x[j]);
      const d = Array.from(a, (v, i) => (v - b0[i]) / e);
      let col: number[];
      if (!S) col = d;
      else {
        const sd = matVec(S, d);
        col = [...sd, ...d.map((v, i) => rippleW * (v - sd[i]))];
      }
      col.push(...Array.from({ length: k }, (_, m) => (m === j ? REG : 0)));
      cols.push(col);
    }
    return cols; // column-major
  };
  const cost = (f: number[]) => f.reduce((s, v) => s + v * v, 0);

  let x = x0.map((v) => Math.min(hi, Math.max(lo, v)));
  let f = residual(x), c = cost(f), lambda = 1e-3;
  for (let it = 0; it < 60; it++) {
    const J = jacobian(x);
    const g = J.map((col) => col.reduce((s, v, i) => s + v * f[i], 0));
    // active set: at a bound and the gradient pushes further out
    const free = x.map((v, j) => !((v <= lo + 1e-9 && g[j] > 0) || (v >= hi - 1e-9 && g[j] < 0)));
    const idx = free.map((fr, j) => (fr ? j : -1)).filter((j) => j >= 0);
    if (!idx.length) break;
    const A = idx.map((a) => idx.map((b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Ad = A.map((r, i) => r.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(Ad, idx.map((j) => -g[j]));
      const xn = [...x];
      idx.forEach((j, m) => { xn[j] = Math.min(hi, Math.max(lo, x[j] + step[m])); });
      const fn = residual(xn), cn = cost(fn);
      if (cn < c) {
        const done = (c - cn) < 1e-9 * Math.max(1, c) || Math.max(...step.map(Math.abs)) < 1e-5;
        x = xn; f = fn; c = cn; lambda = Math.max(1e-7, lambda / 3); improved = true;
        if (done) return x;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return x;
}

function inBandData(target: Vec, o: FitOptions) {
  const idx: number[] = [];
  for (let i = 0; i < GRID.length; i++) if (GRID[i] >= o.fLo && GRID[i] <= o.fHi) idx.push(i);
  return { idx, freqs: idx.map((i) => GRID[i]), t: idx.map((i) => target[i]), frac: idx.map((i) => o.perceptual[i]) };
}

/** Fixed-frequency device: solve every band's gain. */
export function fitFixed(target: Vec, caps: EqCaps, o: FitOptions): FitResult {
  const centers = caps.bands_hz!, q = caps.q!, fs = caps.fs_hz;
  const lo = -Math.abs(o.maxCut), hi = Math.min(o.maxBoost, caps.gain_db[1]);
  const loLim = Math.max(lo, caps.gain_db[0]);
  const free = centers.map((c) => c >= o.fLo / 1.26 && c <= o.fHi * 1.26);
  const shapes = centers.map((c) => ({ fc: c, q, type: "PK" as const })).filter((_, j) => free[j]);
  const d = inBandData(target, o);
  const S = smoothingMatrix(d.freqs, d.frac);
  const x0 = shapes.map((s) => Math.min(hi - 1e-6, Math.max(loLim + 1e-6, interp(s.fc, GRID, target))));
  const x = solveGains(shapes, x0, loLim, hi, d.freqs, d.t, fs, S, o.rippleWeight ?? 0.6);
  const step = caps.gain_step_db || 0.1;
  const gains = centers.map(() => 0);
  let m = 0;
  centers.forEach((_, j) => { if (free[j]) gains[j] = Math.round(x[m++] / step) * step; });
  const filters: Filter[] = centers.map((c, j) => ({ type: "PK" as const, fc_hz: c, gain_db: Math.round(gains[j] * 100) / 100, q }));
  const response = vec();
  const trig = new Trig(GRID, fs);
  filters.forEach((f) => addResponse(response, f, trig));
  return { filters, response };
}

/** Parametric device: greedy placement, then joint gain refinement. */
export function fitParametric(target: Vec, caps: EqCaps, o: FitOptions): FitResult {
  const fs = caps.fs_hz, [qMin, qMax] = caps.q_range ?? [0.5, 8];
  const lo = Math.max(-Math.abs(o.maxCut), caps.gain_db[0]), hi = Math.min(o.maxBoost, caps.gain_db[1]);
  const d = inBandData(target, o);
  const S = smoothingMatrix(d.freqs, d.frac);
  const tS = matVec(S, d.t);
  const trigIn = new Trig(d.freqs, fs);
  const shapes: { fc: number; q: number; type: "PK" }[] = [];
  let gains: number[] = [];
  for (let n = 0; n < caps.max_filters; n++) {
    const cur = vec(d.freqs.length);
    shapes.forEach((s, j) => addResponse(cur, { type: "PK", fc_hz: s.fc, gain_db: gains[j], q: s.q }, trigIn));
    const r = Array.from(matVec(S, cur), (v, i) => tS[i] - v);
    let k = 0;
    r.forEach((v, i) => { if (Math.abs(v) > Math.abs(r[k])) k = i; });
    if (Math.abs(r[k]) < 0.75) break;
    // width at half amplitude -> Q
    let a = k, b = k;
    while (a > 0 && Math.sign(r[a - 1]) === Math.sign(r[k]) && Math.abs(r[a - 1]) > Math.abs(r[k]) / 2) a--;
    while (b < r.length - 1 && Math.sign(r[b + 1]) === Math.sign(r[k]) && Math.abs(r[b + 1]) > Math.abs(r[k]) / 2) b++;
    const bwOct = Math.max(0.05, Math.log2(d.freqs[b] / d.freqs[a]));
    const q = Math.min(qMax, Math.max(qMin, Math.sqrt(2 ** bwOct) / (2 ** bwOct - 1)));
    shapes.push({ fc: d.freqs[k], q, type: "PK" });
    gains.push(Math.min(hi, Math.max(lo, r[k])));
    gains = solveGains(shapes, gains, lo, hi, d.freqs, d.t, fs, S, o.rippleWeight ?? 0.6);
  }
  const step = caps.gain_step_db || 0.1;
  const filters: Filter[] = shapes
    .map((s, j) => ({ type: "PK" as const, fc_hz: Math.round(s.fc * 10) / 10, gain_db: Math.round(Math.round(gains[j] / step) * step * 100) / 100, q: Math.round(s.q * 1000) / 1000 }))
    .filter((f) => Math.abs(f.gain_db) >= step / 2);
  const response = vec();
  const trig = new Trig(GRID, fs);
  filters.forEach((f) => addResponse(response, f, trig));
  return { filters, response };
}

export function fitEq(target: Vec, caps: EqCaps, o: FitOptions): FitResult {
  return caps.kind === "fixed" ? fitFixed(target, caps, o) : fitParametric(target, caps, o);
}
