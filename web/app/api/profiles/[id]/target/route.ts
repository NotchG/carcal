import { handle, body } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };
import type { TargetSpec } from "@/lib/engine/curves";
import type { CalSettings } from "@/lib/engine/engine";

export async function PUT(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = (await ctx.params).id;
    const p = repo.getProfile(id);
    const b = await body<{ target?: TargetSpec; settings?: CalSettings }>(req);
    const target = b.target ?? p.target, settings = b.settings ?? p.settings;
    cal.validateTarget(target, settings);
    const u = repo.updateProfile(id, { target, settings });
    return { target: u.target, settings: u.settings };
  });
}
