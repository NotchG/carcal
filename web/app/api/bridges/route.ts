import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
export const dynamic = "force-dynamic";
import { BridgeClient } from "@/lib/server/bridge";

const pub = (b: repo.Bridge) => ({ id: b.id, name: b.name, url: b.url, device: b.device?.device ?? null, mode: b.device?.mode ?? null, last_ok: b.last_ok });

export async function GET() {
  return handle(() => repo.listBridges().map(pub));
}

/** Save a bridge after checking it answers with the right contract and token. */
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ name?: string; url?: string; token?: string }>(req);
    const url = (b.url ?? "").trim().replace(/\/$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new HttpError(422, "Bridge address must look like http://192.168.1.20:8770");
    if (!b.token?.trim()) throw new HttpError(422, "Enter the token the bridge printed when it started");
    const device = await new BridgeClient(url, b.token.trim()).device();
    return pub(repo.saveBridge(b.name?.trim() || device.device.name, url, b.token.trim(), device));
  });
}
