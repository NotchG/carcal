import "server-only";
import crypto from "node:crypto";
import type { ApplyResult, DeviceDescription, PresetRequest } from "../contract";
import type { TargetSpec } from "../engine/curves";
import type { CalSettings, ChannelDef } from "../engine/engine";
import { db, now } from "./db";
import { HttpError } from "./http";

export interface Bridge { id: string; name: string; url: string; token: string; device: DeviceDescription | null; created: string; last_ok: string | null }
/** drive: which side the steering wheel is on, so the setup guide puts the mic at the right seat. */
export interface Car { make: string; model: string; year: string; drive?: "rhd" | "lhd" }
export interface PresetEntry {
  id: string; at: string; name: string; design: "carcal" | "rew";
  target: TargetSpec; settings: CalSettings; applied: boolean; verified: boolean | null;
  result: Pick<ApplyResult, "manual" | "file" | "ignored" | "warnings" | "mismatches" | "message"> | null;
}
export interface Profile {
  id: string; name: string; car: Car; bridge_id: string; device: DeviceDescription;
  channels: ChannelDef[]; target: TargetSpec; settings: CalSettings;
  setup_complete: boolean; last_applied: PresetEntry | null; created: string; updated: string;
}
export interface Measurement { key: string; spl: number[]; meta: Record<string, unknown>; crossovers: { hp_hz: number | null; lp_hz: number | null } | null; taken: string; stale: boolean }

const J = JSON.stringify;
const P = <T>(s: string | null): T => (s ? JSON.parse(s) : null) as T;

export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "car";

// ---------------- settings ----------------
export function getSetting(key: string, fallback: string): string {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? fallback;
}
export function setSetting(key: string, value: string) {
  db().prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------------- bridges ----------------
const rowToBridge = (r: Record<string, string>): Bridge => ({
  id: r.id, name: r.name, url: r.url, token: r.token, device: P(r.device_json), created: r.created, last_ok: r.last_ok,
});
export function listBridges(): Bridge[] {
  return (db().prepare("SELECT * FROM bridges ORDER BY created").all() as Record<string, string>[]).map(rowToBridge);
}
export function getBridge(id: string): Bridge {
  const r = db().prepare("SELECT * FROM bridges WHERE id = ?").get(id) as Record<string, string> | undefined;
  if (!r) throw new HttpError(404, `no bridge ${id}`);
  return rowToBridge(r);
}
export function saveBridge(name: string, url: string, token: string, device: DeviceDescription): Bridge {
  const existing = listBridges().find((b) => b.url === url);
  if (existing) {
    db().prepare("UPDATE bridges SET name = ?, token = ?, device_json = ?, last_ok = ? WHERE id = ?")
      .run(name, token, J(device), now(), existing.id);
    return getBridge(existing.id);
  }
  const id = `br-${crypto.randomBytes(4).toString("hex")}`;
  db().prepare("INSERT INTO bridges(id, name, url, token, device_json, created, last_ok) VALUES(?,?,?,?,?,?,?)")
    .run(id, name, url, token, J(device), now(), now());
  return getBridge(id);
}
export function touchBridge(id: string, device: DeviceDescription) {
  db().prepare("UPDATE bridges SET device_json = ?, last_ok = ? WHERE id = ?").run(J(device), now(), id);
}
export function deleteBridge(id: string) {
  const used = db().prepare("SELECT COUNT(*) n FROM profiles WHERE bridge_id = ?").get(id) as { n: number };
  if (used.n) throw new HttpError(409, "this bridge is used by a car; delete the car first");
  db().prepare("DELETE FROM bridges WHERE id = ?").run(id);
}

// ---------------- profiles ----------------
const rowToProfile = (r: Record<string, string | number>): Profile => ({
  id: r.id as string, name: r.name as string, car: P(r.car_json as string), bridge_id: r.bridge_id as string,
  device: P(r.device_json as string), channels: P(r.channels_json as string), target: P(r.target_json as string),
  settings: P(r.settings_json as string), setup_complete: !!r.setup_complete,
  last_applied: P(r.last_applied as string), created: r.created as string, updated: r.updated as string,
});

export function listProfiles(): Profile[] {
  return (db().prepare("SELECT * FROM profiles ORDER BY updated DESC").all() as Record<string, string>[]).map(rowToProfile);
}
export function getProfile(id: string): Profile {
  const r = db().prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Record<string, string> | undefined;
  if (!r) throw new HttpError(404, `no car ${id}`);
  return rowToProfile(r);
}

/** Speaker list for a new car, from the bridge's channel defaults. */
export function channelsFrom(device: DeviceDescription): ChannelDef[] {
  return device.channels.map((c) => ({
    key: c.key, label: c.label, role: c.role, pair: c.pair,
    hp_hz: c.default_highpass?.hz ?? null, lp_hz: c.default_lowpass?.hz ?? null,
    level_offset_db: c.default_level_offset_db, distance_cm: null,
  }));
}

export function createProfile(name: string, car: Car, bridge: Bridge, device: DeviceDescription): Profile {
  const base = slug(`${name}`);
  let id = base, n = 2;
  while (db().prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) id = `${base}-${n++}`;
  db().prepare(`INSERT INTO profiles(id, name, car_json, bridge_id, device_json, channels_json, target_json,
                settings_json, setup_complete, created, updated) VALUES(?,?,?,?,?,?,?,?,0,?,?)`)
    .run(id, name, J(car), bridge.id, J(device), J(channelsFrom(device)),
         J({ house: "neutral", custom_points: [], tone: { bass: 0, mid: 0, treble: 0 } }),
         J({ max_boost_db: 3, max_cut_db: 12 }), now(), now());
  return getProfile(id);
}

export function updateProfile(id: string, patch: Partial<Pick<Profile, "name" | "car" | "channels" | "target" | "settings" | "setup_complete" | "device" | "last_applied">>): Profile {
  const p = { ...getProfile(id), ...patch };
  db().prepare(`UPDATE profiles SET name=?, car_json=?, device_json=?, channels_json=?, target_json=?, settings_json=?,
                setup_complete=?, last_applied=?, updated=? WHERE id=?`)
    .run(p.name, J(p.car), J(p.device), J(p.channels), J(p.target), J(p.settings), p.setup_complete ? 1 : 0,
         p.last_applied ? J(p.last_applied) : null, now(), id);
  return getProfile(id);
}

export function deleteProfile(id: string) {
  getProfile(id);
  db().prepare("DELETE FROM profiles WHERE id = ?").run(id);
}

// ---------------- measurements ----------------
export function saveMeasurement(pid: string, key: string, spl: number[], meta: Record<string, unknown>): Measurement {
  const p = getProfile(pid);
  const ch = p.channels.find((c) => c.key === key);
  if (!ch && key !== "noise") throw new HttpError(404, `no speaker ${key}`);
  if (spl.some((v) => !Number.isFinite(v))) throw new HttpError(400, "measurement contains invalid values");
  const xo = ch ? { hp_hz: ch.hp_hz, lp_hz: ch.lp_hz } : null;
  db().prepare(`INSERT INTO measurements(profile_id, key, spl_json, meta_json, crossovers_json, taken) VALUES(?,?,?,?,?,?)
                ON CONFLICT(profile_id, key) DO UPDATE SET spl_json=excluded.spl_json, meta_json=excluded.meta_json,
                crossovers_json=excluded.crossovers_json, taken=excluded.taken`)
    .run(pid, key, J(spl.map((v) => Math.round(v * 100) / 100)), J(meta), xo ? J(xo) : null, now());
  db().prepare("UPDATE profiles SET updated = ? WHERE id = ?").run(now(), pid);
  return listMeasurements(pid)[key];
}

export function listMeasurements(pid: string): Record<string, Measurement> {
  const p = getProfile(pid);
  const chans = Object.fromEntries(p.channels.map((c) => [c.key, c]));
  const rows = db().prepare("SELECT * FROM measurements WHERE profile_id = ?").all(pid) as Record<string, string>[];
  return Object.fromEntries(rows.map((r) => {
    const xo = P<Measurement["crossovers"]>(r.crossovers_json), c = chans[r.key];
    const stale = !!(c && xo && (xo.hp_hz !== c.hp_hz || xo.lp_hz !== c.lp_hz));
    return [r.key, { key: r.key, spl: P(r.spl_json), meta: P(r.meta_json), crossovers: xo, taken: r.taken, stale }];
  }));
}

export function deleteMeasurement(pid: string, key: string) {
  db().prepare("DELETE FROM measurements WHERE profile_id = ? AND key = ?").run(pid, key);
}

// ---------------- presets ----------------
export function addPreset(pid: string, name: string, design: "carcal" | "rew", target: TargetSpec, settings: CalSettings,
                          request: PresetRequest, result: ApplyResult | null): PresetEntry {
  const id = `ps-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const applied = !!result?.applied;
  db().prepare(`INSERT INTO presets(id, profile_id, at, name, design, target_json, settings_json, request_json, result_json, applied, verified)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pid, now(), name, design, J(target), J(settings), J(request), result ? J(result) : null, applied ? 1 : 0,
         result?.verified == null ? null : result.verified ? 1 : 0);
  return getPreset(pid, id);
}

const rowToPreset = (r: Record<string, string | number | null>): PresetEntry => {
  const res = P<ApplyResult | null>(r.result_json as string);
  return {
    id: r.id as string, at: r.at as string, name: r.name as string, design: r.design as "carcal" | "rew",
    target: P(r.target_json as string), settings: P(r.settings_json as string), applied: !!r.applied,
    verified: r.verified == null ? null : !!r.verified,
    result: res ? { manual: res.manual, file: res.file, ignored: res.ignored, warnings: res.warnings, mismatches: res.mismatches, message: res.message } : null,
  };
};

export function listPresets(pid: string): PresetEntry[] {
  return (db().prepare("SELECT * FROM presets WHERE profile_id = ? ORDER BY at DESC, rowid DESC LIMIT 50").all(pid) as Record<string, string>[]).map(rowToPreset);
}
export function getPreset(pid: string, id: string): PresetEntry {
  const r = db().prepare("SELECT * FROM presets WHERE profile_id = ? AND id = ?").get(pid, id) as Record<string, string> | undefined;
  if (!r) throw new HttpError(404, `no preset ${id}`);
  return rowToPreset(r);
}
export function getPresetRequest(pid: string, id: string): PresetRequest {
  const r = db().prepare("SELECT request_json FROM presets WHERE profile_id = ? AND id = ?").get(pid, id) as { request_json: string } | undefined;
  if (!r) throw new HttpError(404, `no preset ${id}`);
  return JSON.parse(r.request_json);
}
export function markPresetApplied(pid: string, id: string, result: ApplyResult) {
  db().prepare("UPDATE presets SET result_json = ?, applied = ?, verified = ? WHERE profile_id = ? AND id = ?")
    .run(J(result), result.applied ? 1 : 0, result.verified == null ? null : result.verified ? 1 : 0, pid, id);
}
