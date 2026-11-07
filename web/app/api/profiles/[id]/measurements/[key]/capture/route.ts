import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string; key: string }> };
import { toGrid } from "@/lib/engine/dsp";

/** Stop REW's RTA, save its average as a measurement, store it for this speaker. */
export async function POST(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, key } = await ctx.params;
    repo.getProfile(id);
    const m = await cal.rewClient().rtaStopAndFetch();
    return repo.saveMeasurement(id, key, Array.from(toGrid(m.freqs, m.spl)), m.meta);
  });
}
