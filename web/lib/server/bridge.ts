import "server-only";
import type { ApplyResult, CompileResult, DeviceDescription, PresetRequest, RestoreResult } from "../contract";
import { CONTRACT } from "../contract";
import { HttpError } from "./http";
import type { Bridge } from "./repo";

/**
 * Client for a DSP bridge. Speaks only the preset contract: the dashboard never knows
 * which DSP is behind it or how presets get into it.
 */
export class BridgeClient {
  constructor(private url: string, private token: string) {}

  static of(b: Pick<Bridge, "url" | "token">) {
    return new BridgeClient(b.url, b.token);
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000, raw = false): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url.replace(/\/$/, "") + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? "timed out" : "not reachable";
      throw new HttpError(502, `DSP bridge ${why} at ${this.url}. Is it running on the Windows laptop, and are both laptops on the same network?`, { bridge_offline: true });
    }
    if (res.status === 401) throw new HttpError(502, "The DSP bridge rejected the token. Check it matches the one the bridge prints at start-up.", { bridge_auth: true });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* keep */ }
      throw new HttpError(res.status === 400 || res.status === 422 ? 400 : 502, `DSP bridge: ${detail}`);
    }
    return (raw ? res : await res.json()) as T;
  }

  async device(): Promise<DeviceDescription> {
    const d = await this.call<DeviceDescription>("GET", "/v1/device", undefined, 8_000);
    if (d.contract !== CONTRACT) throw new HttpError(502, `bridge speaks ${d.contract}, dashboard expects ${CONTRACT}`);
    return d;
  }
  compile(req: PresetRequest) { return this.call<CompileResult>("POST", "/v1/presets/compile", req); }
  // Loading drives the DSP app's dialogs (backup, import, read back): allow two minutes.
  apply(req: PresetRequest) { return this.call<ApplyResult>("POST", "/v1/presets/apply", req, 120_000); }
  restore(to: "last-tune" | "baseline") { return this.call<RestoreResult>("POST", "/v1/restore", { to }, 120_000); }
  captureBaseline() { return this.call<{ source: string; at: string }>("POST", "/v1/baseline/capture", undefined, 60_000); }
  uploadBaseline(data: Uint8Array) { return this.call<{ source: string; at: string }>("PUT", "/v1/baseline", data); }
  file(id: string) { return this.call<Response>("GET", `/v1/files/${encodeURIComponent(id)}`, undefined, 20_000, true); }
}
