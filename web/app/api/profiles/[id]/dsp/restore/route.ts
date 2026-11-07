import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };

/** Put the last applied tune back (or the baseline if nothing was applied yet). */
export async function POST(_req: Request, ctx: Ctx) {
  return handle(async () => cal.bridgeFor(repo.getProfile((await ctx.params).id)).restore("last-tune"));
}
