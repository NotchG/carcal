import "server-only";
import type { ChannelSettings, PresetRequest } from "../contract";
import { CONTRACT } from "../contract";
import { psychoFraction, TargetSpec } from "../engine/curves";
import { addResponse, Filter, fromArray, GRID, round, roundVec, smooth, Trig, Vec } from "../engine/dsp";
import { CalSettings, ChannelResult, Computed, computeAll, toRewTxt } from "../engine/engine";
import type { EqCaps } from "../engine/fit";
import { BridgeClient } from "./bridge";
import { HttpError } from "./http";
import * as repo from "./repo";
import { RewClient } from "./rew";
import { designWithRew } from "./rewDesign";

export const rewClient = () => new RewClient(repo.getSetting("rew_url", process.env.CARCAL_REW_URL ?? "http://127.0.0.1:4735"));
export const bridgeFor = (p: repo.Profile) => BridgeClient.of(repo.getBridge(p.bridge_id));

export interface Preview extends Computed {
  design: "carcal" | "rew";
  stale: string[];
  eq_kind: "fixed" | "parametric";
  delay_writable: boolean;
  warnings: string[];
}

function arrays(pid: string): { meas: Record<string, Vec>; noise: Vec | null } {
  const recs = repo.listMeasurements(pid);
  const meas: Record<string, Vec> = {};
  let noise: Vec | null = null;
  for (const [k, r] of Object.entries(recs)) {
    if (k === "noise") noise = fromArray(r.spl); else meas[k] = fromArray(r.spl);
  }
  return { meas, noise };
}

export function validateTarget(t: TargetSpec, s: CalSettings) {
  for (const k of ["bass", "mid", "treble"] as const) {
    const v = Number(t?.tone?.[k]);
    if (!Number.isFinite(v) || v < -6 || v > 6) throw new HttpError(422, `tone ${k} must be between -6 and 6 dB`);
  }
  if (!["neutral", "warm", "detailed", "flat", "custom"].includes(t.house)) throw new HttpError(422, `unknown target curve ${t.house}`);
  if (!(s.max_boost_db >= 0 && s.max_boost_db <= 6)) throw new HttpError(422, "max boost must be between 0 and 6 dB");
  if (!(s.max_cut_db >= 3 && s.max_cut_db <= 20)) throw new HttpError(422, "max cut must be between 3 and 20 dB");
}

export function preview(pid: string, target: TargetSpec, settings: CalSettings): Preview {
  validateTarget(target, settings);
  const p = repo.getProfile(pid);
  const { meas, noise } = arrays(pid);
  if (!Object.keys(meas).length) throw new HttpError(409, "No measurements yet. Run the measurement setup first.");
  const caps = p.device.capabilities.eq as EqCaps;
  let computed: Computed;
  try {
    computed = computeAll(p.channels, meas, target, settings, caps, noise);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const stale = Object.values(repo.listMeasurements(pid)).filter((m) => m.stale).map((m) => m.key);
  return { ...computed, design: "carcal", stale, eq_kind: caps.kind, delay_writable: p.device.capabilities.delay.writable, warnings: [] };
}

// ---------------- preset requests (device-agnostic) ----------------
const xo = (hz: number | null) => (hz ? { hz, slope_db_oct: 24 } : null);

export function measureRequest(p: repo.Profile, key: string | null): PresetRequest {
  const channels: Record<string, ChannelSettings> = {};
  for (const c of p.channels) {
    channels[c.key] = c.key === key
      ? { mute: false, eq: null, highpass: xo(c.hp_hz), lowpass: xo(c.lp_hz) }
      : { mute: true };
  }
  return { contract: CONTRACT, name: key ? `measure ${key}` : "measure noise floor (all muted)", purpose: "measure", channels };
}

export function tuneRequest(p: repo.Profile, name: string, filters: Record<string, Filter[]>, delays: Record<string, number>): PresetRequest {
  const channels: Record<string, ChannelSettings> = {};
  for (const c of p.channels) {
    const f = filters[c.key];
    channels[c.key] = {
      mute: false, highpass: xo(c.hp_hz), lowpass: xo(c.lp_hz),
      eq: f ? { rew_txt: toRewTxt(f, `${p.name} ${c.label}`) } : null,
      ...(delays[c.key] !== undefined ? { delay_ms: delays[c.key] } : {}),
    };
  }
  return { contract: CONTRACT, name, purpose: "tune", channels };
}

// ---------------- Design with REW ----------------
export async function designWithRewAll(pid: string, target: TargetSpec, settings: CalSettings): Promise<Preview> {
  const base = preview(pid, target, settings);
  const p = repo.getProfile(pid);
  const { meas } = arrays(pid);
  const rew = rewClient();
  const filters: Record<string, Filter[]> = {};
  for (const c of p.channels) {
    const r = base.channels[c.key];
    if (!r) continue;
    const shape = r.target.map((v) => v - r.level_db);   // the speaker's own target curve
    const d = await designWithRew(rew, {
      key: c.key, label: c.label, measured: Array.from(meas[c.key]), targetShape: shape, level: r.level_db,
      fLo: r.f_lo, fHi: r.f_hi, maxBoost: settings.max_boost_db,
    });
    filters[c.key] = d.filters;
  }

  // What the device will actually do with REW's filters: ask the bridge (dry run).
  const warnings: string[] = [];
  let realised: Record<string, number[]> = {};
  try {
    const comp = await bridgeFor(p).compile(tuneRequest(p, "REW design (preview)", filters, {}));
    realised = Object.fromEntries(Object.entries(comp.channels).map(([k, v]) => [k, v.eq_response_db]));
    warnings.push(...comp.warnings);
  } catch (e) {
    warnings.push(`Couldn't ask the DSP bridge how it will realise REW's filters (${(e as Error).message}). Showing REW's ideal filters.`);
  }

  const channels: Record<string, ChannelResult> = {};
  for (const c of p.channels) {
    const r = base.channels[c.key];
    if (!r) continue;
    let eq = realised[c.key];
    if (!eq) {
      const out = new Float64Array(GRID.length);
      const t = new Trig(GRID, p.device.capabilities.eq.fs_hz);
      filters[c.key].forEach((f) => addResponse(out, f, t));
      eq = Array.from(out);
    }
    const frac = psychoFraction(c.role);
    const predicted = smooth(fromArray(Array.from(meas[c.key], (v, i) => v + eq[i])), frac);
    const pb = Array.from(GRID, (f) => f >= (c.hp_hz || 20) && f <= Math.min(c.lp_hz || 20000, c.role === "sub" ? 20000 : 16000));
    const err = r.target.map((t, i) => (pb[i] ? predicted[i] - t : NaN)).filter(Number.isFinite);
    channels[c.key] = {
      ...r, filters: filters[c.key], predicted: roundVec(predicted), eq_curve: roundVec(eq),
      rms_error_db: Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length),
      max_error_db: Math.max(...err.map(Math.abs)),
      notes: [...r.notes.filter((n) => n.startsWith("Narrow dip") || n.includes("quieter than")),
              `Designed by REW's Match target: ${filters[c.key].length} filters`],
    };
  }
  const rs = Object.values(channels);
  const psum = (a: number[][]) => a[0].map((_, i) => round(10 * Math.log10(a.reduce((s, x) => s + 10 ** (x[i] / 10), 0))));
  return { ...base, design: "rew", channels, system_estimate: rs.length ? psum(rs.map((r) => r.predicted)) : [], warnings };
}

// ---------------- apply ----------------
export async function apply(pid: string, target: TargetSpec, settings: CalSettings,
                            design: "carcal" | "rew", rewFilters?: Record<string, Filter[]>) {
  const pv = preview(pid, target, settings);
  const p = repo.getProfile(pid);
  const filters: Record<string, Filter[]> = {};
  for (const [k, r] of Object.entries(pv.channels)) {
    filters[k] = design === "rew" ? (rewFilters?.[k] ?? r.filters) : r.filters;
    for (const f of filters[k]) {
      if (!(f.fc_hz > 0 && f.fc_hz <= 24000 && Math.abs(f.gain_db) <= 30)) throw new HttpError(422, `invalid filter on ${k}`);
    }
  }
  const tone = Object.entries(target.tone).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ");
  const name = `${target.house}${tone ? `, ${tone}` : ""}${design === "rew" ? " (REW)" : ""}`;
  const req = tuneRequest(p, name, filters, pv.delays_ms);
  let result;
  try {
    result = await bridgeFor(p).apply(req);
  } catch (e) {
    // Keep the design so it can be applied later or downloaded as REW filter text.
    const entry = repo.addPreset(pid, name, design, target, settings, req, null);
    if (e instanceof HttpError) { e.extra = { ...e.extra, preset_id: entry.id }; throw e; }
    throw e;
  }
  const entry = repo.addPreset(pid, name, design, target, settings, req, result);
  repo.updateProfile(pid, { target, settings, setup_complete: true, ...(result.applied ? { last_applied: entry } : {}) });
  return { preset: entry, result, delays_ms: pv.delays_ms, delay_writable: pv.delay_writable };
}

export function rewTxtBundle(pid: string, presetId: string): string {
  const req = repo.getPresetRequest(pid, presetId);
  return Object.entries(req.channels)
    .map(([k, c]) => `# ===== ${k} =====\n${c.eq?.rew_txt ?? "(flat)\n"}`)
    .join("\n");
}
