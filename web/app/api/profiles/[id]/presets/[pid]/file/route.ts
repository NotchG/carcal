import { handle, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string; pid: string }> };

/** The device's native file, fetched from the bridge (for importing by hand). */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    const p = repo.getProfile(id);
    const entry = repo.getPreset(id, pid);
    if (!entry.result?.file) throw new HttpError(404, "this preset never reached the bridge; download the REW filters instead");
    const res = await cal.bridgeFor(p).file(entry.result.file.id);
    return new Response(res.body, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${entry.result.file.name.replace(/"/g, "")}"`,
    } });
  });
}
