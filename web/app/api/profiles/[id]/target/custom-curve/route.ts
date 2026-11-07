import { handle, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
type Ctx = { params: Promise<{ id: string }> };
import { parseCurveText } from "@/lib/engine/curves";

/** Import a house curve (REW or Jazzi's tuning companion .txt). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = (await ctx.params).id;
    const p = repo.getProfile(id);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "attach the curve as 'file'");
    let pts: [number, number][];
    try { pts = parseCurveText(await file.text()); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const u = repo.updateProfile(id, { target: { ...p.target, house: "custom", custom_points: pts } });
    return { target: u.target, points: pts.length };
  });
}
