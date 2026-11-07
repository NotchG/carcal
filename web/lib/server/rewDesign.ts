import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Filter, FilterType } from "../engine/dsp";
import { GRID } from "../engine/dsp";
import { HttpError } from "./http";
import { RewClient } from "./rew";

/**
 * "Design with REW": let REW's own Match Target (CAT-BUG 6.5) design a speaker's EQ.
 *
 *   1. put the measurement into REW
 *   2. give REW the speaker's individual target as a house curve (house + tone + LR4),
 *      target type "Full range", no room curve, at carcal's target level
 *   3. Generic equaliser, match range one octave past the crossovers, boost limits
 *   4. Match target, read the filters back
 *
 * REW's API isn't fully documented and versions differ, so each step tries the known
 * variants in order and reports exactly which step REW rejected.
 */

export class RewDesignError extends HttpError {
  constructor(step: string, attempts: string[]) {
    super(502, `Design with REW stopped at "${step}". REW answered: ${attempts.join("; ")}. Design with carcal still works.`, { rew_design_step: step, attempts });
  }
}

interface Variant { method: string; path: string; body?: unknown; raw?: string }

async function tryVariants(rew: RewClient, step: string, variants: Variant[], optional = false) {
  const attempts: string[] = [];
  for (const v of variants) {
    const r = v.raw !== undefined ? await rawCall(rew, v.method, v.path, v.raw) : await rew.call(v.method, v.path, v.body);
    if (r.status >= 200 && r.status < 300) return r;
    attempts.push(`${v.method} ${v.path} → ${r.status}`);
  }
  if (optional) return null;
  throw new RewDesignError(step, attempts);
}

async function rawCall(rew: RewClient, method: string, p: string, raw: string) {
  const res = await fetch(rew.url.replace(/\/$/, "") + p, { method, headers: { "Content-Type": "application/json" }, body: raw, cache: "no-store" });
  return { status: res.status, data: await res.text() };
}

export interface RewDesignInput {
  key: string;
  label: string;
  measured: number[];          // raw, on GRID
  targetShape: number[];       // individual target without level, on GRID (dB)
  level: number;               // absolute target level (dB SPL), same as carcal's
  fLo: number;
  fHi: number;
  maxBoost: number;
}

export async function designWithRew(rew: RewClient, inp: RewDesignInput): Promise<{ filters: Filter[]; rewUuid: string }> {
  const dir = path.join(os.tmpdir(), "carcal-rew");
  fs.mkdirSync(dir, { recursive: true });

  // 1. measurement into REW
  const before = new Set((await rew.measurements()).map((m) => m.uuid));
  const title = `carcal ${inp.label}`;
  const measFile = path.join(dir, `measurement-${inp.key}.txt`);
  fs.writeFileSync(measFile, "* carcal measurement\n* Freq(Hz) SPL(dB)\n" +
    Array.from(GRID, (f, i) => `${f.toFixed(3)} ${inp.measured[i].toFixed(3)}`).join("\n") + "\n");
  const imp = await tryVariants(rew, "import the measurement", [
    { method: "POST", path: "/import/frequency-response-data", body: { title, frequencies: Array.from(GRID), magnitudes: inp.measured } },
    { method: "POST", path: "/import/frequency-response", body: { path: measFile } },
    { method: "POST", path: "/import/frequency-response-file", body: { filePath: measFile } },
  ]);
  let uuid = (imp?.data as { uuid?: string } | null)?.uuid;
  if (!uuid) {
    const fresh = (await rew.measurements()).filter((m) => !before.has(m.uuid));
    uuid = fresh[fresh.length - 1]?.uuid;
  }
  if (!uuid) throw new RewDesignError("find the imported measurement", ["no new measurement appeared"]);
  const M = `/measurements/${uuid}`;

  // 2. target: the speaker's own curve as REW's house curve
  const houseFile = path.join(dir, `target-${inp.key}.txt`);
  fs.writeFileSync(houseFile, Array.from(GRID, (f, i) => `${f.toFixed(3)} ${inp.targetShape[i].toFixed(3)}`).join("\n") + "\n");
  await tryVariants(rew, "set the target (house curve)", [
    { method: "POST", path: "/eq/house-curve", body: { filePath: houseFile } },
    { method: "POST", path: "/eq/house-curve", body: { path: houseFile } },
    { method: "PUT", path: "/eq/house-curve", body: { filePath: houseFile } },
  ]);
  await tryVariants(rew, "choose the Generic equaliser", [
    { method: "POST", path: `${M}/equaliser`, body: { manufacturer: "Generic", model: "Generic" } },
    { method: "PUT", path: `${M}/equaliser`, body: { manufacturer: "Generic", model: "Generic" } },
  ], true);
  await tryVariants(rew, "set target type Full range", [
    { method: "PUT", path: `${M}/target-settings`, body: { shape: "Full range" } },
    { method: "POST", path: `${M}/target-settings`, body: { shape: "Full range" } },
  ]);
  await tryVariants(rew, "turn the room curve off", [
    { method: "PUT", path: `${M}/room-curve-settings`, body: { addRoomCurve: false } },
    { method: "POST", path: `${M}/room-curve-settings`, body: { addRoomCurve: false } },
  ], true);
  await tryVariants(rew, "set the target level", [
    { method: "POST", path: `${M}/target-level`, raw: String(Math.round(inp.level * 100) / 100) },
    { method: "PUT", path: `${M}/target-level`, raw: String(Math.round(inp.level * 100) / 100) },
  ]);

  // 3. match settings (CAT-BUG: individual max boost, overall max boost, flatness 1 dB)
  await tryVariants(rew, "set the match range and boost limits", [
    { method: "POST", path: "/eq/match-target-settings", body: {
      startFrequency: Math.round(inp.fLo), endFrequency: Math.round(inp.fHi),
      individualMaxBoostdB: inp.maxBoost, overallMaxBoostdB: Math.max(0, inp.maxBoost - 1), flatnessTargetdB: 1,
    } },
  ], true);

  // 4. Match target, then read the filters
  await tryVariants(rew, "run Match target", [
    { method: "POST", path: `${M}/eq/command`, body: { command: "Match target" } },
    { method: "POST", path: `${M}/eq/match-target` },
  ]);
  const fr = await tryVariants(rew, "read the filters", [{ method: "GET", path: `${M}/filters` }]);
  const raw = fr!.data;
  const list = (Array.isArray(raw) ? raw : (raw as { filters?: unknown[] })?.filters ?? []) as Record<string, unknown>[];
  const filters: Filter[] = [];
  for (const f of list) {
    if (f.enabled === false) continue;
    const type = String(f.type ?? "PK").toUpperCase();
    if (!["PK", "LS", "HS", "LSC", "HSC"].includes(type)) continue;
    const fc = Number(f.frequency ?? f.fc ?? f.freq), g = Number(f.gaindB ?? f.gain ?? f.gainDb ?? 0);
    const q = f.q ?? f.Q;
    if (!Number.isFinite(fc) || !g) continue;
    filters.push({ type: type as FilterType, fc_hz: fc, gain_db: g, q: q == null ? null : Number(q) });
  }
  return { filters, rewUuid: uuid };
}
