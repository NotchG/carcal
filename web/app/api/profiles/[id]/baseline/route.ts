import { handle, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };

/** Read the DSP's current settings on the bridge side as the baseline. */
export async function POST(_req: Request, ctx: Ctx) {
  return handle(async () => cal.bridgeFor(repo.getProfile((await ctx.params).id)).captureBaseline());
}

/** Upload a native preset file as the baseline (forwarded untouched to the bridge). */
export async function PUT(req: Request, ctx: Ctx) {
  return handle(async () => {
    const p = repo.getProfile((await ctx.params).id);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "attach the preset file as 'file'");
    return cal.bridgeFor(p).uploadBaseline(new Uint8Array(await file.arrayBuffer()));
  });
}
