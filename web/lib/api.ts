import type {
  ApplyResponse, ApplyResult, BridgeInfo, CalSettings, Car, Channel, DeviceDescription, Filter, Health, HouseCurve,
  Measurement, PresetEntry, Preview, Profile, ProfileSummary, RestoreResult, TargetSpec,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: Record<string, unknown>) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach carcal. Is `npm run start` (or `npm run dev`) still running?");
  }
  const text = await res.text();
  let body: Record<string, unknown> | undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok) throw new ApiError(res.status, String(body?.detail ?? `Request failed (${res.status})`), body);
  return body as T;
}

const json = (b: unknown) => JSON.stringify(b);
const P = (id: string) => `/api/profiles/${id}`;
const form = (file: File) => { const f = new FormData(); f.append("file", file); return f; };

export const api = {
  health: () => req<Health>("/api/health"),
  settings: () => req<{ rew_url: string }>("/api/settings"),
  saveSettings: (rew_url: string) => req<{ rew_url: string }>("/api/settings", { method: "PUT", body: json({ rew_url }) }),
  houseCurves: () => req<{ freqs: number[]; curves: HouseCurve[] }>("/api/house-curves"),

  bridges: () => req<BridgeInfo[]>("/api/bridges"),
  addBridge: (name: string, url: string, token: string) => req<BridgeInfo>("/api/bridges", { method: "POST", body: json({ name, url, token }) }),
  deleteBridge: (id: string) => req<{ ok: boolean }>(`/api/bridges/${id}`, { method: "DELETE" }),

  profiles: () => req<ProfileSummary[]>("/api/profiles"),
  createProfile: (name: string, car: Car, bridge_id: string) => req<ProfileSummary>("/api/profiles", { method: "POST", body: json({ name, car, bridge_id }) }),
  profile: (id: string) => req<Profile>(P(id)),
  updateProfile: (id: string, patch: { channels?: Channel[]; setup_complete?: boolean; name?: string; car?: Partial<Car> }) => req<Profile>(P(id), { method: "PUT", body: json(patch) }),
  deleteProfile: (id: string) => req<{ ok: boolean }>(P(id), { method: "DELETE" }),
  device: (id: string) => req<DeviceDescription>(`${P(id)}/device`),

  captureBaseline: (id: string) => req<{ source: string }>(`${P(id)}/baseline`, { method: "POST" }),
  uploadBaseline: (id: string, file: File) => req<{ source: string }>(`${P(id)}/baseline`, { method: "PUT", body: form(file) }),

  measureMode: (id: string, key: string | null) => req<ApplyResult & { playing: string | null }>(`${P(id)}/dsp/measure`, { method: "POST", body: json({ key }) }),
  restore: (id: string) => req<RestoreResult>(`${P(id)}/dsp/restore`, { method: "POST" }),

  measurements: (id: string) => req<{ freqs: number[]; measurements: Record<string, Measurement> }>(`${P(id)}/measurements`),
  rtaStart: (id: string) => req<{ running: boolean }>(`${P(id)}/rta/start`, { method: "POST" }),
  rtaLive: (id: string) => req<{ available: boolean; averages?: number; spl: number[] | null }>(`${P(id)}/rta/live`),
  capture: (id: string, key: string) => req<Measurement>(`${P(id)}/measurements/${key}/capture`, { method: "POST" }),
  pull: (id: string, key: string) => req<Measurement>(`${P(id)}/measurements/${key}/pull`, { method: "POST" }),
  uploadMeasurement: (id: string, key: string, file: File) => req<Measurement>(`${P(id)}/measurements/${key}/upload`, { method: "POST", body: form(file) }),

  saveTarget: (id: string, target: TargetSpec, settings: CalSettings) => req<{ target: TargetSpec }>(`${P(id)}/target`, { method: "PUT", body: json({ target, settings }) }),
  uploadCustomCurve: (id: string, file: File) => req<{ target: TargetSpec; points: number }>(`${P(id)}/target/custom-curve`, { method: "POST", body: form(file) }),
  preview: (id: string, target: TargetSpec, settings: CalSettings, signal?: AbortSignal) =>
    req<Preview>(`${P(id)}/preview`, { method: "POST", body: json({ target, settings }), signal }),
  designWithRew: (id: string, target: TargetSpec, settings: CalSettings) =>
    req<Preview>(`${P(id)}/design-rew`, { method: "POST", body: json({ target, settings }) }),
  apply: (id: string, target: TargetSpec, settings: CalSettings, design: "carcal" | "rew", filters?: Record<string, Filter[]>) =>
    req<ApplyResponse>(`${P(id)}/apply`, { method: "POST", body: json({ target, settings, design, filters }) }),
  presets: (id: string) => req<PresetEntry[]>(`${P(id)}/presets`),
  reapply: (id: string, pid: string) => req<{ preset: PresetEntry; result: ApplyResult }>(`${P(id)}/presets/${pid}/apply`, { method: "POST" }),
  presetFileUrl: (id: string, pid: string) => `${P(id)}/presets/${pid}/file`,
  presetRewTxtUrl: (id: string, pid: string) => `${P(id)}/presets/${pid}/rew-txt`,
  bridgeFileUrl: (id: string, fid: string) => `${P(id)}/bridge-file/${fid}`,
};

/** One sentence for the outcome of a bridge load. */
export function describeLoad(r: Pick<ApplyResult, "applied" | "manual" | "verified" | "mismatches" | "message">, done: string): string {
  if (r.manual) return `The bridge can't load presets by itself right now${r.message ? ` (${r.message})` : ""}. Import the file in the DSP app.`;
  if (!r.applied) return "Not loaded.";
  if (r.verified === false) return `${done}, but the DSP changed some values: ${r.mismatches?.slice(0, 2).join("; ")}`;
  return done;
}
