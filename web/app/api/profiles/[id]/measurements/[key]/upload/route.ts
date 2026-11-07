import { handle, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
type Ctx = { params: Promise<{ id: string; key: string }> };
import { toGrid } from "@/lib/engine/dsp";
import { parseCurveText } from "@/lib/engine/curves";

/** A REW text export ("freq SPL [phase]" per line). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, key } = await ctx.params;
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "attach the REW export as 'file'");
    let pts: [number, number][];
    try { pts = parseCurveText(await file.text()); } catch (e) { throw new HttpError(400, `couldn't read a REW text export: ${(e as Error).message}`); }
    return repo.saveMeasurement(id, key, Array.from(toGrid(pts.map((p) => p[0]), pts.map((p) => p[1]))), { source: "file", filename: file.name });
  });
}
