/** House curves, tone controls and crossover shapes. Mirrors carcal/calib/curves.py. */
import { GRID, LOG_GRID, Vec, addResponse, gridTrig, interp, vec } from "./dsp";

export interface HousePreset { label: string; description: string; points: [number, number][] }

// carcal's own starting points (Hz, dB relative to 1 kHz), not copies of published curves.
export const HOUSE_PRESETS: Record<string, HousePreset> = {
  neutral: {
    label: "Neutral car",
    description: "Moderate bass lift, gentle treble roll-off. A safe starting point.",
    points: [[20, 9], [40, 8.5], [80, 6], [150, 2.5], [300, 0.5], [1000, 0], [3000, -1], [10000, -3.5], [20000, -5]],
  },
  warm: {
    label: "Warm",
    description: "More bass, softer highs. Relaxed for long drives.",
    points: [[20, 12], [40, 11.5], [80, 8], [150, 4], [300, 1.5], [1000, 0], [3000, -2], [10000, -6], [20000, -8]],
  },
  detailed: {
    label: "Detailed",
    description: "Lighter bass lift, near-flat highs. More upfront vocals and detail.",
    points: [[20, 6], [60, 5], [120, 2], [300, 0], [1000, 0], [4000, 0], [10000, -1.5], [20000, -3]],
  },
  flat: {
    label: "Flat",
    description: "No shaping. Useful as a reference; usually sounds thin and bright in a car.",
    points: [[20, 0], [20000, 0]],
  },
};

export function pointsCurve(points: [number, number][]): Vec {
  const pts = [...points].map(([f, g]) => [Number(f), Number(g)] as const).sort((a, b) => a[0] - b[0]);
  const xp = pts.map(([f]) => Math.log10(f)), fp = pts.map(([, g]) => g);
  return LOG_GRID.map((lf) => interp(lf, xp, fp));
}

/** Read a REW / Jazzi house-curve text file: "freq dB" per line. */
export function parseCurveText(text: string): [number, number][] {
  const pts: [number, number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || "*#;\"'".includes(line[0]) || /^[a-z]/i.test(line)) continue;
    const nums = line.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (nums && nums.length >= 2) {
      const f = Number(nums[0]), g = Number(nums[1]);
      if (f >= 1 && f <= 100000) pts.push([f, g]);
    }
  }
  if (pts.length < 2) throw new Error("need at least two 'frequency dB' lines");
  return pts;
}

export interface Tone { bass: number; mid: number; treble: number }

export function toneDb(t: Tone): Vec {
  const out = vec();
  const trig = gridTrig(96000); // analog-like shape; high fs keeps the top octave undistorted
  addResponse(out, { type: "LSC", fc_hz: 100, gain_db: t.bass, q: 0.6 }, trig);
  addResponse(out, { type: "PK", fc_hz: 1000, gain_db: t.mid, q: 0.6 }, trig);
  addResponse(out, { type: "HSC", fc_hz: 5000, gain_db: t.treble, q: 0.6 }, trig);
  return out;
}

/** Ideal 24 dB/oct Linkwitz-Riley magnitude (CAT-BUG's acoustic target slope). */
export function lr4Db(hp: number | null, lp: number | null): Vec {
  return GRID.map((f) => (hp ? 20 * Math.log10(1 / (1 + (hp / f) ** 4)) : 0) + (lp ? 20 * Math.log10(1 / (1 + (f / lp) ** 4)) : 0));
}

export type Role = "front" | "rear" | "sub" | "center" | "other";

/** Smoothing width per frequency (CAT-BUG 6.6): 1/12 oct subs, 1/6 midbass, 1/3 mids and highs. */
export function psychoFraction(role: Role): Vec {
  return GRID.map((f) => (role === "sub" ? 1 / 12 : f < 300 ? 1 / 6 : 1 / 3));
}

export interface TargetSpec { house: string; custom_points: [number, number][]; tone: Tone }

export function houseDb(t: TargetSpec): Vec {
  if (t.house === "custom") {
    if (!t.custom_points?.length) throw new Error("custom house curve selected but no points loaded");
    const c = pointsCurve(t.custom_points);
    const at1k = interp(Math.log10(1000), LOG_GRID, c);
    return c.map((v) => v - at1k);
  }
  const p = HOUSE_PRESETS[t.house];
  if (!p) throw new Error(`unknown house curve ${t.house}`);
  return pointsCurve(p.points);
}

export function systemDb(t: TargetSpec): Vec {
  const h = houseDb(t), tone = toneDb(t.tone);
  return h.map((v, i) => v + tone[i]);
}
