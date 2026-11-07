import { handle } from "@/lib/server/http";
import * as cal from "@/lib/server/calibrate";
export const dynamic = "force-dynamic";
import { toGrid, roundVec } from "@/lib/engine/dsp";

export async function GET() {
  return handle(async () => {
    const l = await cal.rewClient().rtaLive();
    return { available: l.available, averages: l.averages, spl: l.freqs && l.spl ? roundVec(toGrid(l.freqs, l.spl)) : null };
  });
}
