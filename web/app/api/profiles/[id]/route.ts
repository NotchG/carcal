import { handle, body, HttpError } from "@/lib/server/http";
import * as repo from "@/lib/server/repo";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
import { summary } from "@/lib/server/summary";
import type { ChannelDef } from "@/lib/engine/engine";

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const p = repo.getProfile((await ctx.params).id);
    return { ...p, summary: summary(p) };
  });
}

export async function PUT(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = (await ctx.params).id;
    const p = repo.getProfile(id);
    const b = await body<{ name?: string; car?: repo.Car; channels?: ChannelDef[]; setup_complete?: boolean }>(req);
    const patch: Parameters<typeof repo.updateProfile>[1] = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 80);
    if (b.car) {
      const c = { ...p.car, ...b.car };
      if (c.drive !== undefined && c.drive !== "rhd" && c.drive !== "lhd") throw new HttpError(422, "drive must be rhd or lhd");
      patch.car = { make: String(c.make ?? ""), model: String(c.model ?? ""), year: String(c.year ?? ""), drive: c.drive };
    }
    if (b.setup_complete !== undefined) patch.setup_complete = !!b.setup_complete;
    if (b.channels) {
      const known = new Set(p.device.channels.map((c) => c.key));
      const seen = new Set<string>();
      patch.channels = b.channels.map((c) => {
        if (!known.has(c.key)) throw new HttpError(422, `the bridge has no speaker ${c.key}`);
        if (seen.has(c.key)) throw new HttpError(422, `speaker ${c.key} listed twice`);
        seen.add(c.key);
        const hz = (v: unknown, n: string) => {
          if (v === null || v === undefined || v === "") return null;
          const x = Number(v);
          if (!Number.isFinite(x) || x < 20 || x > 20000) throw new HttpError(422, `${c.label} ${n} must be 20-20000 Hz`);
          return x;
        };
        const dist = c.distance_cm == null ? null : Number(c.distance_cm);
        if (dist !== null && !(dist >= 10 && dist <= 500)) throw new HttpError(422, `${c.label} distance must be 10-500 cm`);
        const off = Number(c.level_offset_db ?? 0);
        if (!(off >= -20 && off <= 10)) throw new HttpError(422, `${c.label} level must be -20 to +10 dB`);
        const orig = p.channels.find((x) => x.key === c.key) ?? repo.channelsFrom(p.device).find((x) => x.key === c.key)!;
        return { ...orig, label: String(c.label || orig.label), hp_hz: hz(c.hp_hz, "high-pass"), lp_hz: hz(c.lp_hz, "low-pass"), level_offset_db: off, distance_cm: dist };
      });
    }
    const u = repo.updateProfile(id, patch);
    return { ...u, summary: summary(u) };
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => { repo.deleteProfile((await ctx.params).id); return { ok: true }; });
}
