import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string; pid: string }> };

/** Every speaker's filters as REW text (works without the bridge). */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    repo.getPreset(id, pid);
    return new Response(cal.rewTxtBundle(id, pid), { headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="carcal-${pid}-rew-filters.txt"`,
    } });
  });
}
