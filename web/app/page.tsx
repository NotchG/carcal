"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { BridgeInfo, ProfileSummary } from "@/lib/types";
import s from "./garage.module.css";

function statusOf(p: ProfileSummary): { text: string; tone: "ok" | "warn" | "" } {
  if (!p.setup_complete && p.missing.length) {
    return p.measured.length
      ? { text: `Setup in progress: ${p.missing.length} speaker${p.missing.length > 1 ? "s" : ""} left to measure`, tone: "warn" }
      : { text: "Not measured yet", tone: "" };
  }
  if (p.stale.length) return { text: `Re-measure ${p.stale.join(", ")} (crossover changed)`, tone: "warn" };
  if (p.last_applied) return { text: `Tuned: ${p.last_applied.name}`, tone: "ok" };
  return { text: "Measured, not applied yet", tone: "" };
}

function BridgeForm({ onAdded, first }: { onAdded: (b: BridgeInfo) => void; first: boolean }) {
  const [f, setF] = useState({ name: "", url: "http://", token: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { onAdded(await api.addBridge(f.name, f.url, f.token)); setF({ name: "", url: "http://", token: "" }); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className={s.form} aria-label="Connect a DSP bridge">
      {first && (
        <p className={`${s.wide} dim`}>
          The DSP bridge runs on the laptop connected to your DSP. Start it there with
          <code> python -m carcal.bridge</code>; it prints its address and a token.
        </p>
      )}
      <label className="field">Bridge address
        <input type="text" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://192.168.1.20:8770" required />
      </label>
      <label className="field">Token
        <input type="text" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off" required />
      </label>
      <label className="field">Name (optional)
        <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Windows laptop" />
      </label>
      <div className={s.submit}><button className="btn btn-primary" disabled={busy}>{busy ? "Connecting…" : "Connect bridge"}</button></div>
      {err && <p className={`notice error ${s.wide}`} role="alert">{err}</p>}
    </form>
  );
}

export default function Garage() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [bridges, setBridges] = useState<BridgeInfo[] | null>(null);
  const [rewUrl, setRewUrl] = useState("");
  const [rewMsg, setRewMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", make: "", model: "", year: "", drive: "rhd" as "rhd" | "lhd", bridge: "" });
  const [busy, setBusy] = useState(false);
  const [addingBridge, setAddingBridge] = useState(false);

  useEffect(() => {
    Promise.all([api.profiles(), api.bridges(), api.settings()])
      .then(([p, b, st]) => {
        setProfiles(p); setBridges(b); setRewUrl(st.rew_url);
        setForm((f) => ({ ...f, bridge: f.bridge || b[0]?.id || "" }));
      })
      .catch((e) => setError(e.message));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const name = form.name.trim() || [form.make, form.model].filter(Boolean).join(" ") || "My car";
      const p = await api.createProfile(name, { make: form.make, model: form.model, year: form.year, drive: form.drive }, form.bridge);
      router.push(`/cars/${p.id}/setup`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const bridgeAdded = (b: BridgeInfo) => {
    setBridges((bs) => [...(bs ?? []).filter((x) => x.id !== b.id), b]);
    setForm((f) => ({ ...f, bridge: b.id }));
    setAddingBridge(false);
  };

  const saveRew = async () => {
    setRewMsg(null);
    try { const r = await api.saveSettings(rewUrl); setRewUrl(r.rew_url); setRewMsg("Saved."); }
    catch (e) { setRewMsg((e as Error).message); }
  };

  const noBridge = bridges !== null && bridges.length === 0;

  return (
    <main className={`shell ${s.page}`}>
      <section>
        <h1 className={s.title}>Which car are we tuning?</h1>
        {error && <p className="notice error" role="alert">{error}</p>}
        {profiles && profiles.length === 0 && (
          <p className="dim">No cars yet. Connect the DSP bridge, add your car, and the setup walks you through measuring it.</p>
        )}
        {profiles && profiles.length > 0 && (
          <ul className={s.list}>
            {profiles.map((p) => {
              const st = statusOf(p);
              return (
                <li key={p.id}>
                  <Link href={`/cars/${p.id}`} className={s.row}>
                    <span className={s.car}>{p.name}</span>
                    <span className={s.device}>{p.device_name}{p.bridge ? ` on ${p.bridge}` : ""}</span>
                    <span className={s.state}><span className={`dot ${st.tone}`} /> {st.text}</span>
                    <span className={`${s.when} faint`}>{p.last_applied ? `Applied ${new Date(p.last_applied.at).toLocaleDateString()}` : ""}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {noBridge ? (
        <section className={s.add} aria-labelledby="connect">
          <h2 id="connect">Connect your DSP bridge</h2>
          <BridgeForm onAdded={bridgeAdded} first />
        </section>
      ) : (
        <section className={s.add} aria-labelledby="add-car">
          <h2 id="add-car">Add a car</h2>
          <form onSubmit={create} className={s.form}>
            <label className="field">Make
              <input type="text" value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} placeholder="Wuling" />
            </label>
            <label className="field">Model
              <input type="text" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Almaz" />
            </label>
            <label className="field">Year
              <input type="text" inputMode="numeric" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} placeholder="2023" />
            </label>
            <label className="field">Steering wheel
              <select value={form.drive} onChange={(e) => setForm({ ...form, drive: e.target.value as "rhd" | "lhd" })}>
                <option value="rhd">On the right</option>
                <option value="lhd">On the left</option>
              </select>
            </label>
            <label className="field">Name it (optional)
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Daily driver" />
            </label>
            <label className="field">DSP
              <select value={form.bridge} onChange={(e) => setForm({ ...form, bridge: e.target.value })}>
                {(bridges ?? []).map((b) => <option key={b.id} value={b.id}>{b.device?.name ?? "DSP"} on {b.name}</option>)}
              </select>
            </label>
            <div className={s.submit}>
              <button className="btn btn-primary" disabled={busy || !form.bridge}>{busy ? "Adding…" : "Add car and start setup"}</button>
            </div>
          </form>
        </section>
      )}

      <section className={s.conn} aria-labelledby="connections">
        <h2 id="connections">Connections</h2>
        <div className={s.connRow}>
          <label className="field">REW address (REW runs on this Mac with its API on)
            <input type="text" value={rewUrl} onChange={(e) => setRewUrl(e.target.value)} />
          </label>
          <button className="btn" onClick={saveRew}>Save</button>
          {rewMsg && <span className="faint">{rewMsg}</span>}
        </div>
        {!noBridge && (
          <>
            <ul className={s.bridgeList}>
              {(bridges ?? []).map((b) => (
                <li key={b.id}>
                  <span><b>{b.name}</b> <span className="dim">{b.url}</span></span>
                  <span className="faint">{b.device?.name}{b.mode === "sim" ? " (simulated)" : ""}</span>
                  <button className="btn btn-quiet" onClick={async () => {
                    try { await api.deleteBridge(b.id); setBridges((bs) => (bs ?? []).filter((x) => x.id !== b.id)); }
                    catch (e) { setError((e as Error).message); }
                  }}>Remove</button>
                </li>
              ))}
            </ul>
            {addingBridge ? <BridgeForm onAdded={bridgeAdded} first={false} />
              : <div><button className="btn btn-quiet" onClick={() => setAddingBridge(true)}>Connect another bridge</button></div>}
          </>
        )}
      </section>
    </main>
  );
}
