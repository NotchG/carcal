"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import MeasurePanel from "@/components/MeasurePanel";
import { CabinMap, type Drive } from "@/components/MicGuide";
import { useHealth } from "@/components/TopBar";
import { api } from "@/lib/api";
import type { Channel, DeviceDescription, Measurement, Profile } from "@/lib/types";
import s from "./setup.module.css";

const STEPS = ["Check your setup", "Baseline and crossovers", "Noise floor",
               "Measure each speaker", "Speaker distances", "Finish"] as const;

const CHECKLIST: { group: string; items: string[] }[] = [
  { group: "Windows (sound settings for the mic input)", items: [
    "Mic input volume at 100",
    "Sample rate 48 kHz, 24-bit",
    "All enhancements turned off",
  ]},
  { group: "Laptops", items: [
    "Windows laptop: Rainbow app open and connected to the amp, carcal bridge running",
    "Mac and Windows laptop on the same network (phone hotspot works)",
  ]},
  { group: "REW (on this Mac)", items: [
    "Started with the API on (roomeqwizard -api, or Preferences → API)",
    "Preferences → Soundcard: 48 kHz, your mic as input",
    "Preferences → Cal files: your Audyssey calibration file, matching the mic's orientation",
    "RTA settings: 1/48 octave, no smoothing, FFT 64k, Rectangular window, 93.75% overlap",
  ]},
  { group: "Pink noise on your phone", items: [
    "REW Generator → Noise → Pink periodic → Full range → Save to file, 440 repetitions (10 minutes)",
    "File copied to the phone and playing through Android Auto",
  ]},
  { group: "Car and head unit", items: [
    "Battery charger connected, engine off, doors closed, fan off",
    "Head unit EQ flat, fader and balance centred, sound effects off",
    "Volume fixed for the whole session: loud but bearable (80–85 dB)",
  ]},
];

// Checklist ticks live in localStorage (per car); useSyncExternalStore keeps the
// server render (no storage) and the browser render consistent.
const listeners = new Set<() => void>();
const ckKey = (id: string) => `carcal-check-${id}`;
const EMPTY = "{}";
function readChecklistRaw(id: string): string {
  try { return localStorage.getItem(ckKey(id)) ?? EMPTY; } catch { return EMPTY; }
}
function writeChecklist(id: string, v: Record<string, boolean>) {
  try { localStorage.setItem(ckKey(id), JSON.stringify(v)); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}
function useChecklist(id: string): Record<string, boolean> {
  const raw = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => readChecklistRaw(id),
    () => EMPTY,
  );
  return useMemo(() => { try { return JSON.parse(raw); } catch { return {}; } }, [raw]);
}

function Setup() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { health } = useHealth();
  const [step, setStep] = useState(() => Math.min(5, Math.max(0, Number(search.get("step") ?? 0))));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [freqs, setFreqs] = useState<number[]>([]);
  const [meas, setMeas] = useState<Record<string, Measurement>>({});
  const [device, setDevice] = useState<DeviceDescription | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dirty, setDirty] = useState(false);
  const [active, setActive] = useState<string | null>(search.get("channel"));
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tapeFocus, setTapeFocus] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.profile(id), api.measurements(id)])
      .then(([p, m]) => {
        setProfile(p); setChannels(p.channels); setFreqs(m.freqs); setMeas(m.measurements); setDevice(p.device);
        // live status from the bridge (falls back to the stored description if offline)
        api.device(id).then(setDevice).catch((e) => setMsg({ tone: "error", text: e.message }));
      })
      .catch((e) => setMsg({ tone: "error", text: e.message }));
  }, [id]);

  const checked = useChecklist(id);
  const toggleCheck = (k: string) => writeChecklist(id, { ...checked, [k]: !checked[k] });
  const goto = (n: number) => { setStep(n); setMsg(null); };

  const done = useMemo(() => {
    const keys = profile?.channels.map((c) => c.key) ?? [];
    const allMeasured = keys.length > 0 && keys.every((k) => meas[k] && !meas[k].stale);
    return [
      CHECKLIST.every((g) => g.items.every((i) => checked[i])),
      device?.baseline.source === "captured" || device?.baseline.source === "uploaded",
      !!meas.noise,
      allMeasured,
      (profile?.channels ?? []).every((c) => c.distance_cm),
      !!profile?.setup_complete,
    ];
  }, [profile, meas, checked, device]);

  const saveChannels = async () => {
    setBusy(true);
    try {
      const p = await api.updateProfile(id, { channels });
      setProfile(p); setChannels(p.channels); setDirty(false);
      setMeas((await api.measurements(id)).measurements);
      setMsg({ tone: "ok", text: "Saved." });
    } catch (e) { setMsg({ tone: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const editCh = (key: string, patch: Partial<Channel>) => {
    setChannels((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    setDirty(true);
  };

  const captureBaseline = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.captureBaseline(id);
      setDevice(await api.device(id));
      setMsg({ tone: "ok", text: "Read the DSP's current settings. Measurement presets will keep everything except mutes and EQ." });
    } catch (e) { setMsg({ tone: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const uploadBaseline = async (f: File) => {
    setBusy(true); setMsg(null);
    try { await api.uploadBaseline(id, f); setDevice(await api.device(id)); setMsg({ tone: "ok", text: "Baseline loaded from file." }); }
    catch (e) { setMsg({ tone: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const useBridgeDefaults = () => {
    if (!device) return;
    setChannels((cs) => cs.map((c) => {
      const d = device.channels.find((x) => x.key === c.key);
      return d ? { ...c, hp_hz: d.default_highpass?.hz ?? null, lp_hz: d.default_lowpass?.hz ?? null, level_offset_db: d.default_level_offset_db } : c;
    }));
    setDirty(true);
  };

  const setDrive = async (drive: Drive) => {
    if (!profile || profile.car.drive === drive) return;
    setProfile({ ...profile, car: { ...profile.car, drive } });
    try { setProfile(await api.updateProfile(id, { car: { drive } })); }
    catch (e) { setMsg({ tone: "error", text: (e as Error).message }); }
  };

  const finish = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.restore(id);
      await api.updateProfile(id, { setup_complete: true });
      router.push(`/cars/${id}`);
    } catch (e) { setMsg({ tone: "error", text: (e as Error).message }); setBusy(false); }
  };

  if (!profile) {
    return <main className="shell">{msg ? <p className="notice error">{msg.text}</p> : <p className="dim">Loading…</p>}</main>;
  }

  const current = active ?? profile.channels.find((c) => !meas[c.key] || meas[c.key].stale)?.key ?? profile.channels[0]?.key;
  const currentCh = profile.channels.find((c) => c.key === current);
  const drive: Drive = profile.car.drive ?? "rhd";
  const delays = (() => {
    const d = channels.filter((c) => c.distance_cm);
    const far = Math.max(...d.map((c) => c.distance_cm!));
    return Object.fromEntries(d.map((c) => [c.key, (far - c.distance_cm!) / 34.3]));
  })();

  return (
    <main className={`shell ${s.layout}`}>
      <nav className={s.rail} aria-label="Setup steps">
        <Link href={profile.setup_complete ? `/cars/${id}` : "/"} className="btn btn-quiet">
          {profile.setup_complete ? `Back to ${profile.name}` : "All cars"}
        </Link>
        <h1 className={s.carName}>{profile.name}</h1>
        <p className="faint">{profile.summary.device_name}</p>
        <ol className={s.stepList}>
          {STEPS.map((label, i) => (
            <li key={label}>
              <button onClick={() => goto(i)}
                      className={`${s.stepBtn} ${i === step ? s.stepActive : ""}`}
                      aria-current={i === step ? "step" : undefined}>
                <span className={`${s.stepNum} ${done[i] ? s.stepDone : ""}`}>{done[i] ? "✓" : i + 1}</span>
                <span className={s.stepLabel}>
                  {label}
                  {i === 4 && <span className="faint">Optional</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className={s.content} aria-live="polite">
        <h2 className={s.stepTitle}>{STEPS[step]}</h2>
        {msg && <p className={`notice ${msg.tone}`} role={msg.tone === "error" ? "alert" : undefined}>{msg.text}</p>}

        {step === 0 && (
          <div className={s.stack}>
            <p className="dim">Follows CAT-BUG section 4. Tick things off as you go; they&apos;re saved on this computer.</p>
            <div className={s.conn}>
              <span><span className={`dot ${health?.rew.connected ? "ok" : "bad"}`} /> REW API {health?.rew.connected ? "connected" : "not reachable"}</span>
              {(() => {
                const b = health?.bridges.find((x) => x.id === profile.bridge_id);
                const ok = b?.ok && b.status?.automation;
                const text = !b ? "DSP bridge: checking…" : !b.ok ? `DSP bridge offline (${b.url})`
                  : !b.status?.automation ? "DSP bridge online, but it can't drive the DSP app: you'll import presets by hand"
                  : b.status.amp_connected === false ? "DSP bridge online; the DSP app says the amp isn't connected" : `DSP bridge online: ${b.device}`;
                return <span><span className={`dot ${ok ? "ok" : b && !b.ok ? "bad" : "warn"}`} /> {text}</span>;
              })()}
            </div>
            {CHECKLIST.map((g) => (
              <fieldset key={g.group} className={s.check}>
                <legend>{g.group}</legend>
                {g.items.map((it) => (
                  <label key={it}>
                    <input type="checkbox" checked={!!checked[it]} onChange={() => toggleCheck(it)} /> {it}
                  </label>
                ))}
              </fieldset>
            ))}
            <div><button className="btn btn-primary" onClick={() => goto(1)}>Continue</button></div>
          </div>
        )}

        {step === 1 && (
          <div className={s.stack}>
            <div className={s.block}>
              <h3>Baseline</h3>
              <p className="dim">
                Measurement presets are built from your DSP&apos;s current settings, so input routing and anything
                else you&apos;ve set stays as it is. Currently using: <b>{device?.baseline.source ?? "unknown (bridge offline)"}</b>.
              </p>
              <div className={s.row}>
                <button className="btn" onClick={captureBaseline} disabled={busy}>Read settings from the DSP</button>
                <label className="btn btn-quiet">
                  Load a .dspSingle file
                  <input type="file" accept=".dspSingle,application/json" hidden
                         onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBaseline(f); e.target.value = ""; }} />
                </label>
              </div>
            </div>

            <div className={s.block}>
              <h3>Crossovers</h3>
              <p className="dim">
                Speakers are measured with these filters in place, and each speaker&apos;s target uses the same points.
                Keep the high-pass safe: around the midbass&apos;s resonance (Fs) for door speakers, 60–80 Hz is typical.
                Leave a box empty for no filter.
              </p>
              <table className={s.table}>
                <thead>
                  <tr><th scope="col">Speaker</th><th scope="col">Type</th><th scope="col">High-pass, Hz</th><th scope="col">Low-pass, Hz</th><th scope="col">Level vs fronts, dB</th><th /></tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.key}>
                      <th scope="row">{c.label}</th>
                      <td className="dim">{{ front: "Front", rear: "Rear", sub: "Subwoofer", center: "Centre", other: "Other" }[c.role]}</td>
                      <td><input type="number" min={20} max={20000} value={c.hp_hz ?? ""} aria-label={`${c.label} high-pass`}
                                 onChange={(e) => editCh(c.key, { hp_hz: e.target.value ? Number(e.target.value) : null })} /></td>
                      <td><input type="number" min={20} max={20000} value={c.lp_hz ?? ""} aria-label={`${c.label} low-pass`}
                                 onChange={(e) => editCh(c.key, { lp_hz: e.target.value ? Number(e.target.value) : null })} /></td>
                      <td><input type="number" min={-20} max={10} step={0.5} value={c.level_offset_db} aria-label={`${c.label} level`}
                                 onChange={(e) => editCh(c.key, { level_offset_db: Number(e.target.value) })} /></td>
                      <td>
                        <button className="btn btn-quiet" aria-label={`Remove ${c.label}`}
                                onClick={() => { setChannels((cs) => cs.filter((x) => x.key !== c.key)); setDirty(true); }}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={s.row}>
                <button className="btn btn-primary" onClick={saveChannels} disabled={!dirty || busy}>Save crossovers</button>
                <button className="btn btn-quiet" onClick={useBridgeDefaults} disabled={!device}>Reset to the bridge&apos;s defaults</button>
              </div>
              {Object.values(meas).some((m) => m.stale) && (
                <p className="notice">Speakers measured with different crossovers need measuring again.</p>
              )}
            </div>
            <div><button className="btn" onClick={() => goto(2)} disabled={dirty}>Continue</button></div>
          </div>
        )}

        {step === 2 && (
          <div className={s.stack}>
            <p className="dim">What the car sounds like with every speaker muted, so each speaker can be checked against it. carcal mutes the DSP for you; the pink noise can keep playing.</p>
            <MeasurePanel key="noise" pid={id} freqs={freqs} mkey="noise" saved={meas.noise}
                          channels={profile.channels} drive={drive} onDriveChange={setDrive}
                          onSaved={(m) => setMeas((x) => ({ ...x, noise: m }))} />
            <div><button className="btn" onClick={() => goto(3)} disabled={!meas.noise}>Continue</button></div>
          </div>
        )}

        {step === 3 && currentCh && (
          <div className={s.stack}>
            <div className={s.tabs} role="tablist" aria-label="Speakers">
              {profile.channels.map((c) => {
                const m = meas[c.key];
                return (
                  <button key={c.key} role="tab" aria-selected={c.key === current}
                          className={`${s.tab} ${c.key === current ? s.tabActive : ""}`} onClick={() => setActive(c.key)}>
                    <span className={`dot ${m ? (m.stale ? "warn" : "ok") : ""}`} /> {c.label}
                  </button>
                );
              })}
            </div>
            <MeasurePanel key={currentCh.key} pid={id} freqs={freqs} mkey={currentCh.key} channel={currentCh}
                          channels={profile.channels} drive={drive} onDriveChange={setDrive}
                          saved={meas[currentCh.key]?.stale ? undefined : meas[currentCh.key]} noise={meas.noise}
                          onSaved={(m) => {
                            // pin this speaker so the panel doesn't jump to the next
                            // unmeasured one before the result has been seen
                            setActive(currentCh.key);
                            setMeas((x) => ({ ...x, [currentCh.key]: m }));
                          }} />
            <div className={s.row}>
              {(() => {
                const idx = profile.channels.findIndex((c) => c.key === current);
                const next = profile.channels[idx + 1];
                return next
                  ? <button className="btn" onClick={() => setActive(next.key)} disabled={!meas[current!]}>Next: {next.label}</button>
                  : <button className="btn" onClick={() => goto(4)} disabled={!done[3]}>Continue</button>;
              })()}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className={s.stack}>
            <p className="dim">
              For time alignment (CAT-BUG 9.2): measure from the middle of your head to each speaker&apos;s voice coil,
              a little behind the grille. The farthest speaker gets no delay; closer ones wait for it.
            </p>
            <div className={s.distGrid}>
            <table className={s.table}>
              <thead><tr><th scope="col">Speaker</th><th scope="col">Distance, cm</th><th scope="col">Delay</th></tr></thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.key}>
                    <th scope="row">{c.label}</th>
                    <td><input type="number" min={10} max={500} value={c.distance_cm ?? ""} aria-label={`${c.label} distance`}
                               onFocus={() => setTapeFocus(c.key)} onBlur={() => setTapeFocus(null)}
                               onChange={(e) => editCh(c.key, { distance_cm: e.target.value ? Number(e.target.value) : null })} /></td>
                    <td className="num">{delays[c.key] !== undefined ? `${delays[c.key].toFixed(3)} ms` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <figure className={s.distFig}>
              <CabinMap channels={channels} drive={drive} mode="distances" focusKey={tapeFocus}
                        distances={Object.fromEntries(channels.map((c) => [c.key, c.distance_cm]))} />
              <figcaption className="faint">From the middle of your head to each speaker.</figcaption>
            </figure>
            </div>
            <p className="faint">
              {device?.capabilities.delay.writable
                ? "These delays are sent to the DSP with every tune."
                : `The bridge won't write delays yet (${device?.capabilities.delay.note ?? "not supported"}), so the dashboard shows them for you to type into the DSP app.`}
            </p>
            <div className={s.row}>
              <button className="btn btn-primary" onClick={saveChannels} disabled={!dirty || busy}>Save distances</button>
              <button className="btn" onClick={() => goto(5)}>{dirty ? "Skip" : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className={s.stack}>
            {done[3] ? (
              <p>All speakers are measured. Next, the dashboard: pick a target curve, adjust bass, mids and highs, and apply it to the DSP.</p>
            ) : (
              <p className="notice">
                {profile.channels.filter((c) => !meas[c.key] || meas[c.key].stale).map((c) => c.label).join(", ")} still
                {" "}need measuring. Unmeasured speakers keep a flat EQ.
              </p>
            )}
            <div className={s.row}>
              <button className="btn btn-primary" onClick={finish} disabled={busy || !profile.channels.some((c) => meas[c.key])}>
                {busy ? "Restoring your settings…" : "Restore my settings and open the dashboard"}
              </button>
            </div>
            <p className="faint">This puts your normal DSP settings back, so every speaker plays again.</p>
          </div>
        )}
      </section>
    </main>
  );
}

export default function SetupPage() {
  return <Suspense fallback={<main className="shell"><p className="dim">Loading…</p></main>}><Setup /></Suspense>;
}
