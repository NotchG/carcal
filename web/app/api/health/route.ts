import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
export const dynamic = "force-dynamic";
import { BridgeClient } from "@/lib/server/bridge";

export async function GET() {
  return handle(async () => {
    const rew = await cal.rewClient().status();
    const bridges = await Promise.all(repo.listBridges().map(async (b) => {
      try {
        const d = await BridgeClient.of(b).device();
        repo.touchBridge(b.id, d);
        return { id: b.id, name: b.name, url: b.url, ok: true, mode: d.mode, device: d.device.name, status: d.status };
      } catch (e) {
        return { id: b.id, name: b.name, url: b.url, ok: false, error: (e as Error).message };
      }
    }));
    return { rew, bridges };
  });
}
