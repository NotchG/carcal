import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
export const dynamic = "force-dynamic";
import { BridgeClient } from "@/lib/server/bridge";
import { summary } from "@/lib/server/summary";

export async function GET() {
  return handle(() => repo.listProfiles().map(summary));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ name?: string; car?: repo.Car; bridge_id?: string }>(req);
    if (!b.bridge_id) throw new HttpError(422, "Choose the DSP bridge this car uses");
    const bridge = repo.getBridge(b.bridge_id);
    const device = await BridgeClient.of(bridge).device();      // fresh capabilities and speakers
    repo.touchBridge(bridge.id, device);
    const car = { make: b.car?.make ?? "", model: b.car?.model ?? "", year: b.car?.year ?? "",
                  drive: b.car?.drive === "lhd" ? "lhd" as const : "rhd" as const };
    const name = b.name?.trim() || [car.make, car.model].filter(Boolean).join(" ") || "My car";
    return summary(repo.createProfile(name.slice(0, 80), car, bridge, device));
  });
}
