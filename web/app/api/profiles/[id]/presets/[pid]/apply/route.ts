import { handle } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string; pid: string }> };

/** Send a stored preset request to the bridge again. */
export async function POST(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    const p = repo.getProfile(id);
    const result = await cal.bridgeFor(p).apply(repo.getPresetRequest(id, pid));
    repo.markPresetApplied(id, pid, result);
    const entry = repo.getPreset(id, pid);
    if (result.applied) repo.updateProfile(id, { last_applied: entry, target: entry.target, settings: entry.settings });
    return { preset: entry, result };
  });
}
