import { handle } from "@/lib/server/http";
import { HOUSE_PRESETS, houseDb } from "@/lib/engine/curves";
import { GRID, roundVec } from "@/lib/engine/dsp";

export async function GET() {
  return handle(() => ({
    freqs: roundVec(GRID, 2),
    curves: Object.entries(HOUSE_PRESETS).map(([id, p]) => ({
      id, label: p.label, description: p.description,
      curve: roundVec(houseDb({ house: id, custom_points: [], tone: { bass: 0, mid: 0, treble: 0 } })),
    })),
  }));
}
