import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
type Ctx = { params: Promise<{ id: string; key: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => { const { id, key } = await ctx.params; repo.deleteMeasurement(id, key); return { ok: true }; });
}
