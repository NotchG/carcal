import { handle } from "@/lib/server/http";
import * as cal from "@/lib/server/calibrate";

export async function POST() {
  return handle(async () => { await cal.rewClient().rtaStart(); return { running: true }; });
}
