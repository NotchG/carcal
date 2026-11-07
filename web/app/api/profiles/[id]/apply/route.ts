import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };
import type { TargetSpec } from "@/lib/engine/curves";
import type { CalSettings } from "@/lib/engine/engine";
import type { Filter } from "@/lib/engine/dsp";

/** Send the tune to the DSP bridge as a preset request. */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = (await ctx.params).id;
    const p = repo.getProfile(id);
    const b = await body<{ target?: TargetSpec; settings?: CalSettings; design?: "carcal" | "rew"; filters?: Record<string, Filter[]> }>(req);
    const design = b.design === "rew" ? "rew" : "carcal";
    if (design === "rew" && !b.filters) throw new HttpError(422, "a REW design needs its filters; run Design with REW first");
    return cal.apply(id, b.target ?? p.target, b.settings ?? p.settings, design, b.filters);
  });
}
