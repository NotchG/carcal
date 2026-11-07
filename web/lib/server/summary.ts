import "server-only";
import * as repo from "./repo";

/** What the garage list shows for one car. */
export function summary(p: repo.Profile) {
  const m = repo.listMeasurements(p.id);
  const keys = p.channels.map((c) => c.key);
  let bridge: string | null = null;
  try { bridge = repo.getBridge(p.bridge_id).name; } catch { /* deleted */ }
  return {
    id: p.id, name: p.name, car: p.car, device_name: p.device.device.name, bridge,
    setup_complete: p.setup_complete, measured: keys.filter((k) => m[k]), missing: keys.filter((k) => !m[k]),
    stale: keys.filter((k) => m[k]?.stale), last_applied: p.last_applied, updated: p.updated,
  };
}

