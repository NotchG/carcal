import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
type Ctx = { params: Promise<{ id: string }> };

/** Load "only this speaker playing" (or everything muted for the noise floor) into the DSP. */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const p = repo.getProfile((await ctx.params).id);
    const { key } = await body<{ key: string | null }>(req);
    if (key !== null && !p.channels.some((c) => c.key === key)) throw new HttpError(404, `no speaker ${key}`);
    const r = await cal.bridgeFor(p).apply(cal.measureRequest(p, key));
    return { ...r, playing: key };
  });
}
