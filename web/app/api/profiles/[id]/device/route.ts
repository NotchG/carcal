import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Live device description from the bridge (status, capabilities, baseline). */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const p = repo.getProfile((await ctx.params).id);
    const d = await cal.bridgeFor(p).device();
    repo.touchBridge(p.bridge_id, d);
    repo.updateProfile(p.id, { device: d });
    return d;
  });
}
