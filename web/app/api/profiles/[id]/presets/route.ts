import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => repo.listPresets((await ctx.params).id));
}
