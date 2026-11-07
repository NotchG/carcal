import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";

type Ctx = { params: Promise<{ id: string; fid: string }> };

/** Any native file the bridge compiled (e.g. a measurement preset to import by hand). */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, fid } = await ctx.params;
    const p = repo.getProfile(id);
    const res = await cal.bridgeFor(p).file(fid);
    const cd = res.headers.get("content-disposition") ?? `attachment; filename="${fid}"`;
    return new Response(res.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": cd } });
  });
}
