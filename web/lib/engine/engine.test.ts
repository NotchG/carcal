import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/golden.json";
import { GRID, fromArray, toGrid } from "./dsp";
import { parseCurveText, systemDb } from "./curves";
import { ChannelDef, computeAll, toRewTxt } from "./engine";
import { EqCaps, fitParametric } from "./fit";

const ISO_31 = [20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const CAPS: EqCaps = { kind: "fixed", bands_hz: ISO_31, q: 7.613, max_filters: 31, gain_db: [-12, 12], gain_step_db: 0.1, fs_hz: 48000 };

const rms = (a: number[], b: number[], mask?: boolean[]) => {
  let s = 0, n = 0;
  a.forEach((v, i) => { if (!mask || mask[i]) { s += (v - b[i]) ** 2; n++; } });
  return Math.sqrt(s / n);
};

describe("grid", () => {
  it("matches the Python grid", () => {
    expect(GRID.length).toBe(golden.grid.length);
    golden.grid.forEach((f, i) => expect(Math.abs(GRID[i] - f)).toBeLessThan(0.01));
  });
});

describe.each(golden.scenarios.map((s) => [s.name, s] as const))("golden: %s", (_name, sc) => {
  const inp = sc.input;
  const channels = inp.channels as unknown as ChannelDef[];
  const meas = Object.fromEntries(Object.entries(inp.measurements).map(([k, v]) => [k, fromArray(v)]));
  const out = computeAll(channels, meas, inp.target as never, inp.settings, CAPS, fromArray(inp.noise));
  const ref = sc.output;

  it("produces the same channels and delays", () => {
    expect(Object.keys(out.channels).sort()).toEqual(Object.keys(ref.channels).sort());
    expect(out.delays_ms).toEqual(ref.delays_ms);
  });

  it.each(Object.keys(ref.channels))("%s: same targets, levels and smoothed measurement", (k) => {
    const a = out.channels[k], b = (ref.channels as Record<string, typeof ref.channels.FL>)[k];
    expect(Math.abs(a.level_db - b.level_db)).toBeLessThan(0.05);
    expect(Math.abs(a.deficit_db - b.deficit_db)).toBeLessThanOrEqual(0.1);
    expect(rms(a.target, b.target)).toBeLessThan(0.02);
    expect(rms(a.measured, b.measured)).toBeLessThan(0.02);
  });

  it.each(Object.keys(ref.channels))("%s: same predicted result (solvers differ, outcome must not)", (k) => {
    const a = out.channels[k], b = (ref.channels as Record<string, typeof ref.channels.FL>)[k];
    expect(rms(a.predicted, b.predicted)).toBeLessThan(0.25);
    expect(Math.abs(a.rms_error_db - b.rms_error_db)).toBeLessThan(0.15);
    const dipsA = a.notes.filter((n) => n.startsWith("Narrow dip")).length;
    const dipsB = b.notes.filter((n: string) => n.startsWith("Narrow dip")).length;
    expect(dipsA).toBe(dipsB);
  });

  it("same whole-system lines", () => {
    expect(rms(out.system_target, ref.system_target)).toBeLessThan(0.05);
    expect(rms(out.system_estimate, ref.system_estimate)).toBeLessThan(0.25);
  });
});

describe("filters and formats", () => {
  it("fixed-grid filters sit on the device's bands with its Q", () => {
    const sc = golden.scenarios[0];
    const meas = Object.fromEntries(Object.entries(sc.input.measurements).map(([k, v]) => [k, fromArray(v)]));
    const out = computeAll(sc.input.channels as unknown as ChannelDef[], meas, sc.input.target as never, sc.input.settings, CAPS);
    for (const r of Object.values(out.channels)) {
      for (const f of r.filters) {
        expect(ISO_31).toContain(f.fc_hz);
        expect(f.q).toBeCloseTo(7.613);
        expect(f.gain_db).toBeLessThanOrEqual(sc.input.settings.max_boost_db + 1e-9);
      }
    }
  });

  it("REW text round-trips through the same parser rules the bridge uses", () => {
    const txt = toRewTxt([{ type: "PK", fc_hz: 125, gain_db: -5, q: 7.613 }, { type: "PK", fc_hz: 2500, gain_db: 2.5, q: 7.613 }]);
    expect(txt).toMatch(/Filter  1: ON  PK\s+Fc   125\.0 Hz  Gain  -5\.00 dB  Q  7\.613/);
    expect(txt).toMatch(/Fc   2500 Hz  Gain  2\.50 dB/);
  });

  it("parametric designer reduces a broad + narrow correction", () => {
    const target = GRID.map((f) => -6 * Math.exp(-((Math.log2(f / 150)) ** 2) / 0.1) + 3 * Math.exp(-((Math.log2(f / 3000)) ** 2) / 0.5));
    const caps: EqCaps = { kind: "parametric", q_range: [0.5, 8], max_filters: 6, gain_db: [-12, 6], gain_step_db: 0.1, fs_hz: 48000 };
    const frac = GRID.map((f) => (f < 300 ? 1 / 6 : 1 / 3));
    const r = fitParametric(target, caps, { fLo: 40, fHi: 16000, maxBoost: 6, maxCut: 12, perceptual: frac });
    expect(r.filters.length).toBeGreaterThan(0);
    expect(r.filters.length).toBeLessThanOrEqual(6);
    expect(rms(Array.from(r.response), Array.from(target))).toBeLessThan(0.6);
  });

  it("parses REW/Jazzi house curves and normalises custom curves at 1 kHz", () => {
    const pts = parseCurveText("* Jazzi export\n20 10\n100 6\n1000 2\n20000 -4\n");
    const sys = systemDb({ house: "custom", custom_points: pts, tone: { bass: 0, mid: 0, treble: 0 } });
    const i1k = GRID.findIndex((f) => f >= 1000);
    expect(Math.abs(sys[i1k])).toBeLessThan(0.05);
    expect(toGrid([10, 100000], [1, 1])[0]).toBe(1);
  });
});
