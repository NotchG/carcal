import { handle, body } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };
import type { TargetSpec } from "@/lib/engine/curves";
import type { CalSettings } from "@/lib/engine/engine";

/** Let REW's Match target design the filters (same targets and levels as carcal). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = (await ctx.params).id;
    const p = repo.getProfile(id);
    const b = await body<{ target?: TargetSpec; settings?: CalSettings }>(req);
    return cal.designWithRewAll(id, b.target ?? p.target, b.settings ?? p.settings);
  });
}
