import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
type Ctx = { params: Promise<{ bid: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => { repo.deleteBridge((await ctx.params).bid); return { ok: true }; });
}
