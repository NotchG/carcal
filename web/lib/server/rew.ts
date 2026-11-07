import "server-only";
import { HttpError } from "./http";

/**
 * Client for REW's REST API (REW started with -api; it listens on localhost:4735).
 * Next.js and REW run on the same Mac, so this is called server-side (REW sends no CORS
 * headers, so the browser can't call it directly).
 *
 * Frequency data comes back as base64 big-endian float32 with startFreq + ppo/freqStep.
 */

export class NeedsManualSave extends HttpError {
  constructor() {
    super(409, "RTA stopped, but REW didn't create a measurement through the API. Click 'Save current' (floppy icon) in REW's RTA window, then press 'Pull from REW'.", { needs_manual_save: true });
  }
}

export function decodeFloats(b64: string): number[] {
  const buf = Buffer.from(b64 || "", "base64");
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatBE(i));
  return out;
}

export function decodeResponse(d: Record<string, unknown>): { freqs: number[]; spl: number[] } {
  const mag = d.magnitude ?? d.magnitudes ?? d.levels ?? d.spl;
  const spl = typeof mag === "string" ? decodeFloats(mag) : Array.isArray(mag) ? mag.map(Number) : null;
  if (!spl) throw new HttpError(502, `REW sent no magnitude data (keys: ${Object.keys(d).join(", ")})`);
  const start = (d.startFreq ?? d.startFrequency) as number | undefined;
  const ppo = (d.ppo ?? d.pointsPerOctave) as number | undefined;
  const step = d.freqStep as number | undefined;
  if (start === undefined) throw new HttpError(502, "REW response has no startFreq");
  const freqs = spl.map((_, i) => (ppo ? start * Math.exp((i * Math.LN2) / ppo) : start + i * (step ?? 0)));
  if (!ppo && !step) throw new HttpError(502, "REW response has neither ppo nor freqStep");
  const keep = freqs.map((f, i) => f > 0 && Number.isFinite(spl[i]));
  return { freqs: freqs.filter((_, i) => keep[i]), spl: spl.filter((_, i) => keep[i]) };
}

export interface RewMeasurement { uuid: string; title: string }

export class RewClient {
  constructor(public url: string) {}

  async call(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; data: unknown }> {
    let res: Response;
    try {
      res = await fetch(this.url.replace(/\/$/, "") + path, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch {
      throw new HttpError(502, `REW isn't reachable at ${this.url}. Start REW with its API on (roomeqwizard -api, or Preferences → API).`, { rew_offline: true });
    }
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    return { status: res.status, data };
  }

  async status(): Promise<{ connected: boolean; url: string; error?: string }> {
    try {
      const r = await this.call("GET", "/measurements", undefined, 3_000);
      return { connected: r.status === 200, url: this.url };
    } catch (e) {
      return { connected: false, url: this.url, error: (e as Error).message };
    }
  }

  async measurements(): Promise<RewMeasurement[]> {
    const r = await this.call("GET", "/measurements");
    if (r.status !== 200 || !r.data) return [];
    const items = Array.isArray(r.data) ? r.data : Object.values(r.data as object);
    return items.filter((m) => m && typeof m === "object").map((m, i) => {
      const o = m as Record<string, unknown>;
      return { uuid: String(o.uuid ?? o.id ?? i), title: String(o.title ?? o.name ?? `Measurement ${i + 1}`) };
    });
  }

  async frequencyResponse(uuid: string) {
    const r = await this.call("GET", `/measurements/${uuid}/frequency-response?ppo=48`);
    if (r.status !== 200 || !r.data || typeof r.data !== "object") throw new HttpError(502, `REW couldn't send measurement ${uuid} (HTTP ${r.status})`);
    return decodeResponse(r.data as Record<string, unknown>);
  }

  async rtaCommand(command: string): Promise<boolean> {
    const r = await this.call("POST", "/rta/command", { command, parameters: [] });
    return r.status >= 200 && r.status < 300;
  }

  async rtaStart() {
    await this.rtaCommand("Reset");
    if (!(await this.rtaCommand("Start"))) throw new HttpError(502, "REW refused to start the RTA. Open REW's RTA window once, then try again.");
  }

  async rtaLive(): Promise<{ available: boolean; freqs?: number[]; spl?: number[]; averages?: number }> {
    const r = await this.call("GET", "/rta/levels", undefined, 4_000);
    if (r.status !== 200 || !r.data || typeof r.data !== "object") return { available: false };
    const d = r.data as Record<string, unknown>;
    const out: { available: boolean; freqs?: number[]; spl?: number[]; averages?: number } = { available: true };
    try { Object.assign(out, decodeResponse(d)); } catch { /* levels without spectrum */ }
    const avg = d.averages ?? d.averageCount ?? d.numAverages;
    if (typeof avg === "number") out.averages = avg;
    return out;
  }

  /** Stop the RTA and save its average as a REW measurement, then read it. */
  async rtaStopAndFetch() {
    const before = new Set((await this.measurements()).map((m) => m.uuid));
    await this.rtaCommand("Stop");
    const r = await this.call("GET", "/rta/commands");
    const cmds = Array.isArray(r.data) ? (r.data as string[]) : [];
    const lc = (s: string) => s.toLowerCase();
    const order = [
      ...cmds.filter((c) => lc(c).includes("save") && lc(c).includes("current")),
      ...cmds.filter((c) => lc(c).includes("save") && !lc(c).includes("current")),
      ...cmds.filter((c) => lc(c).includes("capture")),
    ];
    for (const c of order.length ? order : ["Save current", "Capture"]) {
      if (!(await this.rtaCommand(c))) continue;
      for (let i = 0; i < 15; i++) {
        const fresh = (await this.measurements()).filter((m) => !before.has(m.uuid));
        if (fresh.length) {
          const m = fresh[fresh.length - 1];
          return { ...(await this.frequencyResponse(m.uuid)), meta: { source: "rew", rew_uuid: m.uuid, rew_title: m.title, rew_command: c } };
        }
        await new Promise((ok) => setTimeout(ok, 200));
      }
    }
    throw new NeedsManualSave();
  }

  async pullLatest() {
    const ms = await this.measurements();
    if (!ms.length) throw new HttpError(409, "REW has no measurements yet");
    const m = ms[ms.length - 1];
    return { ...(await this.frequencyResponse(m.uuid)), meta: { source: "rew", rew_uuid: m.uuid, rew_title: m.title } };
  }
}
