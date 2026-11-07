import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
import { GRID, roundVec } from "@/lib/engine/dsp";

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => ({ freqs: roundVec(GRID, 2), measurements: repo.listMeasurements((await ctx.params).id) }));
}
