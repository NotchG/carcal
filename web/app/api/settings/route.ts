import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
import * as cal from "@/lib/server/calibrate";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() => ({ rew_url: cal.rewClient().url }));
}

export async function PUT(req: Request) {
  return handle(async () => {
    const b = await body<{ rew_url?: string }>(req);
    if (b.rew_url) {
      if (!/^https?:\/\/[^\s]+$/.test(b.rew_url)) throw new HttpError(422, "REW address must start with http://");
      repo.setSetting("rew_url", b.rew_url.replace(/\/$/, ""));
    }
    return { rew_url: cal.rewClient().url };
  });
}
