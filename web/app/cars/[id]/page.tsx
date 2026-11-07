"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Fader from "@/components/Fader";
import FreqChart from "@/components/FreqChart";
import { ApiError, api, describeLoad } from "@/lib/api";
import type { ApplyResponse, CalSettings, DeviceDescription, Filter, HouseCurve, PresetEntry, Preview, Profile, TargetSpec } from "@/lib/types";
import s from "./dashboard.module.css";

function EqBars({ gains }: { gains: number[] }) {
  const w = 4, gap = 1.5, h = 34, mid = h / 2, scale = mid / 12;
  return (
    <svg width={gains.length * (w + gap)} height={h} aria-label="EQ bands" role="img" className={s.bars}>
      <line x1={0} x2={gains.length * (w + gap)} y1={mid} y2={mid} className={s.barsZero} />
      {gains.map((g, i) => (
        <rect key={i} x={i * (w + gap)} width={w} y={g >= 0 ? mid - g * scale : mid}
              height={Math.max(0.5, Math.abs(g) * scale)} className={g > 0 ? s.barUp : s.barDown} />
      ))}
    </svg>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (t: TargetSpec, st: CalSettings) => JSON.stringify([t, st]);

/** Per-band gains for the mini chart: on the device's fixed bands, or the filter list. */
function barGains(filters: Filter[], bands: number[] | null): number[] {
  if (!bands) return filters.map((f) => f.gain_db);
  return bands.map((b) => filters.find((f) => Math.abs(f.fc_hz / b - 1) < 0.01)?.gain_db ?? 0);
}

export default function Dashboard() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [device, setDevice] = useState<DeviceDescription | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [curves, setCurves] = useState<HouseCurve[]>([]);
  const [target, setTarget] = useState<TargetSpec | null>(null);
  const [settings, setSettings] = useState<CalSettings | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rew, setRew] = useState<{ key: string; design: Preview } | null>(null);
  const [designing, setDesigning] = useState(false);
  const [view, setView] = useState("system");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [failedPreset, setFailedPreset] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.profile(id);
        if (!p.setup_complete) { router.replace(`/cars/${id}/setup`); return; }
        const [hc, ps] = await Promise.all([api.houseCurves(), api.presets(id)]);
        setProfile(p); setDevice(p.device); setTarget(p.target); setSettings(p.settings); setCurves(hc.curves); setPresets(ps);
        api.device(id).then((d) => { setDevice(d); setDeviceErr(null); }).catch((e) => setDeviceErr(e.message));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [id, router]);

  // Live carcal design: recompute every speaker's EQ from stored measurements.
  useEffect(() => {
    if (!target || !settings) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.preview(id, target, settings, ctl.signal)
        .then((p) => { setPreview(p); setError(null); })
        .catch((e) => { if (e.name !== "AbortError") setError(e.message); });
    }, 180);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [id, target, settings]);

  const current = target && settings ? keyOf(target, settings) : "";
  const rewActive = !!rew && rew.key === current;
  const shown = rewActive ? rew!.design : preview;
  const design: "carcal" | "rew" = rewActive ? "rew" : "carcal";
  const applied = profile?.last_applied;
  const dirty = !!target && !!settings && !(applied && same(applied.target, target) && same(applied.settings, settings) && applied.design === design);

  const designWithRew = async () => {
    if (!target || !settings) return;
    setDesigning(true); setError(null);
    try { setRew({ key: keyOf(target, settings), design: await api.designWithRew(id, target, settings) }); }
    catch (e) { setError((e as Error).message); }
    setDesigning(false);
  };

  const apply = async () => {
    if (!target || !settings || !shown) return;
    setApplying(true); setApplyError(null); setResult(null); setFailedPreset(null);
    try {
      const filters = rewActive ? Object.fromEntries(Object.entries(rew!.design.channels).map(([k, v]) => [k, v.filters])) : undefined;
      const r = await api.apply(id, target, settings, design, filters);
      setResult(r);
      if (r.result.applied) setProfile((p) => (p ? { ...p, last_applied: r.preset, target, settings } : p));
      setPresets(await api.presets(id));
    } catch (e) {
      setApplyError((e as Error).message);
      if (e instanceof ApiError && typeof e.detail?.preset_id === "string") {
        setFailedPreset(e.detail.preset_id);
        setPresets(await api.presets(id));
      }
    }
    setApplying(false);
  };

  const reapply = async (pr: PresetEntry) => {
    setRowBusy(pr.id); setError(null);
    try {
      const r = await api.reapply(id, pr.id);
      if (r.result.applied) {
        setProfile((p) => (p ? { ...p, last_applied: r.preset } : p));
        setTarget(pr.target); setSettings(pr.settings);
      } else if (r.result.manual) {
        window.location.assign(api.presetFileUrl(id, pr.id));
      }
      setPresets(await api.presets(id));
    } catch (e) { setError((e as Error).message); }
    setRowBusy(null);
  };

  const importCurve = async (f: File) => {
    try {
      const r = await api.uploadCustomCurve(id, f);
      setTarget((t) => (t ? { ...t, house: "custom", custom_points: r.target.custom_points } : t));
    } catch (e) { setError((e as Error).message); }
  };

  const remove = async () => {
    if (!profile || !confirm(`Delete ${profile.name} and all its measurements? Presets already in the DSP stay there.`)) return;
    await api.deleteProfile(id);
    router.push("/");
  };

  const chans = profile?.channels ?? [];
  const ch = shown?.channels[view];
  const chDef = chans.find((c) => c.key === view);
  const bands = device?.capabilities.eq.kind === "fixed" ? device.capabilities.eq.bands_hz : null;
  const traces = useMemo(() => {
    if (!shown) return [];
    if (view === "system" || !ch) {
      return [
        { id: "t", label: "Target", values: shown.system_target, kind: "target" as const },
        { id: "e", label: "Predicted, all speakers", values: shown.system_estimate, kind: "predicted" as const },
      ];
    }
    return [
      { id: "m", label: "Measured", values: ch.measured, kind: "measured" as const },
      { id: "t", label: "Target", values: ch.target, kind: "target" as const },
      { id: "p", label: "With EQ, as heard", values: ch.predicted, kind: "predicted" as const },
    ];
  }, [shown, view, ch]);

  if (!profile || !target || !settings) {
    return <main className="shell">{error ? <p className="notice error">{error}</p> : <p className="dim">Loading…</p>}</main>;
  }

  const setTone = (k: keyof TargetSpec["tone"], v: number) => setTarget({ ...target, tone: { ...target.tone, [k]: v } });
  const stale = shown?.stale ?? profile.summary.stale;
  const unmeasured = profile.summary.missing;
  const status = device?.status;

  return (
    <main className={`shell ${s.page}`}>
      <header className={s.head}>
        <div>
          <Link href="/" className="btn btn-quiet">All cars</Link>
          <h1 className={s.title}>{profile.name}</h1>
          <p className="dim">
            {device?.device.name ?? profile.summary.device_name}
            {deviceErr ? <span className={s.devBad}>, bridge offline</span>
              : status && !status.automation ? <span className={s.devWarn}>, presets imported by hand</span>
              : status?.amp_connected === false ? <span className={s.devWarn}>, amp not connected</span> : null}
          </p>
        </div>
        <div className={s.headActions}>
          <Link href={`/cars/${id}/setup?step=3`} className="btn">Re-measure speakers</Link>
          <Link href={`/cars/${id}/setup?step=1`} className="btn btn-quiet">Crossovers and setup</Link>
        </div>
      </header>

      {stale.length > 0 && (
        <p className="notice">
          {stale.join(", ")} {stale.length > 1 ? "were" : "was"} measured with different crossovers. Their EQ will be off until you{" "}
          <Link href={`/cars/${id}/setup?step=3&channel=${stale[0]}`}>measure again</Link>.
        </p>
      )}
      {unmeasured.length > 0 && <p className="notice">{unmeasured.join(", ")} not measured: EQ stays flat on {unmeasured.length > 1 ? "those" : "that"} speaker.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}

      <div className={s.grid}>
        <div className={s.mainCol}>
          <section className={s.chartArea} aria-label="Frequency response">
            <div className={s.views} role="tablist" aria-label="Chart view">
              {[{ key: "system", label: "Whole system" }, ...chans.filter((c) => shown?.channels[c.key]).map((c) => ({ key: c.key, label: c.label }))].map((v) => (
                <button key={v.key} role="tab" aria-selected={view === v.key}
                        className={`${s.view} ${view === v.key ? s.viewActive : ""}`} onClick={() => setView(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
            {shown ? (
              <>
                <FreqChart freqs={shown.freqs} traces={traces} height={420} band={ch ? [ch.f_lo, ch.f_hi] : null}
                           ariaLabel={view === "system" ? "Target and predicted response of the whole system" : `${chDef?.label}: measured, target and with EQ`} />
                {view === "system" && <p className="faint">Both lines add up every speaker, smoothed the way hearing averages sound. Phase is ignored, so treat this as a guide and let your ears judge.</p>}
                {ch && (
                  <div className={s.eqStrip}>
                    <p className="faint">
                      The EQ itself, unsmoothed{rewActive ? ", as the DSP will realise REW's filters" : ""}.
                      {bands ? " Narrow fixed bands leave notches between band centres when a broad cut is needed; narrow dips like these are much less audible than peaks." : ""}
                    </p>
                    <FreqChart freqs={shown.freqs} height={150} yRange={[-13, 7]} zeroLine unit="dB" band={[ch.f_lo, ch.f_hi]}
                               ariaLabel={`EQ applied to ${chDef?.label}`}
                               traces={[{ id: "eq", label: `EQ on ${chDef?.label}`, values: ch.eq_curve, kind: "eq" }]} />
                  </div>
                )}
              </>
            ) : <div className={s.chartPlaceholder}>Calculating…</div>}
          </section>

          {shown && (
            <section className={s.section} aria-labelledby="per-speaker">
              <h2 id="per-speaker">Per speaker</h2>
              {shown.warnings.length > 0 && <div className="notice">{shown.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
              <table className={s.table}>
                <thead><tr><th scope="col">Speaker</th><th scope="col">Off target</th><th scope="col">EQ</th><th scope="col">Notes</th></tr></thead>
                <tbody>
                  {chans.filter((c) => shown.channels[c.key]).map((c) => {
                    const r = shown.channels[c.key];
                    return (
                      <tr key={c.key}>
                        <th scope="row"><button className={s.link} onClick={() => setView(c.key)}>{c.label}</button></th>
                        <td className="num">±{r.rms_error_db.toFixed(1)} dB</td>
                        <td><EqBars gains={barGains(r.filters, rewActive ? null : bands)} /></td>
                        <td className={s.notes}>{r.notes.length ? r.notes.map((n) => <p key={n}>{n}</p>) : <span className="faint">None</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!shown.delay_writable && Object.keys(shown.delays_ms).length > 0 && (
                <div className={s.delays}>
                  <h3>Time alignment</h3>
                  <p className="dim">The bridge doesn&apos;t write delays to this DSP yet. Type these into the DSP app&apos;s delay boxes (ms).</p>
                  <ul>
                    {chans.filter((c) => shown.delays_ms[c.key] !== undefined).map((c) => (
                      <li key={c.key}><span>{c.label}</span> <b className="num">{shown.delays_ms[c.key].toFixed(3)} ms</b></li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {presets.length > 0 && (
            <section className={s.section} aria-labelledby="history">
              <h2 id="history">Applied before</h2>
              <ul className={s.history}>
                {presets.slice(0, 12).map((pr) => {
                  const onDsp = applied?.id === pr.id;
                  return (
                    <li key={pr.id}>
                      <span className="num faint">{new Date(pr.at + "Z").toLocaleString()}</span>
                      <span>{pr.name}{!pr.applied ? <span className="faint"> (not loaded)</span> : null}</span>
                      <span className={s.histActions}>
                        {onDsp ? <span className="faint">On the DSP now</span> : (
                          <button className="btn btn-quiet" disabled={rowBusy !== null} onClick={() => reapply(pr)}>
                            {rowBusy === pr.id ? "Loading…" : "Load into DSP"}
                          </button>
                        )}
                        {pr.result?.file && <a className="btn btn-quiet" href={api.presetFileUrl(id, pr.id)} download>DSP file</a>}
                        <a className="btn btn-quiet" href={api.presetRewTxtUrl(id, pr.id)} download>REW filters</a>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <aside className={s.controls} aria-label="Target controls">
          <fieldset className={s.house}>
            <legend>Target curve</legend>
            {curves.map((c) => (
              <label key={c.id} className={`${s.houseOpt} ${target.house === c.id ? s.houseOn : ""}`}>
                <input type="radio" name="house" value={c.id} checked={target.house === c.id} onChange={() => setTarget({ ...target, house: c.id })} />
                <span><b>{c.label}</b><span className="faint">{c.description}</span></span>
              </label>
            ))}
            {target.custom_points.length > 0 && (
              <label className={`${s.houseOpt} ${target.house === "custom" ? s.houseOn : ""}`}>
                <input type="radio" name="house" value="custom" checked={target.house === "custom"} onChange={() => setTarget({ ...target, house: "custom" })} />
                <span><b>Your curve</b><span className="faint">{target.custom_points.length} points, imported</span></span>
              </label>
            )}
            <button className="btn btn-quiet" onClick={() => fileRef.current?.click()}>Import a curve (REW or Jazzi .txt)</button>
            <input ref={fileRef} type="file" accept=".txt,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importCurve(f); e.target.value = ""; }} />
          </fieldset>

          <div className={s.faders}>
            <Fader label="Bass" hint="below 100 Hz" value={target.tone.bass} onChange={(v) => setTone("bass", v)} />
            <Fader label="Mids" hint="around 1 kHz" value={target.tone.mid} onChange={(v) => setTone("mid", v)} />
            <Fader label="Highs" hint="above 5 kHz" value={target.tone.treble} onChange={(v) => setTone("treble", v)} />
          </div>
          {(target.tone.bass || target.tone.mid || target.tone.treble) ? (
            <button className="btn btn-quiet" onClick={() => setTarget({ ...target, tone: { bass: 0, mid: 0, treble: 0 } })}>Reset to 0</button>
          ) : null}

          <details className={s.adv}>
            <summary>EQ limits</summary>
            <label className="field">Largest boost per band: <span className="num">{settings.max_boost_db} dB</span>
              <input type="range" min={0} max={6} step={0.5} value={settings.max_boost_db}
                     onChange={(e) => setSettings({ ...settings, max_boost_db: Number(e.target.value) })} />
            </label>
            <p className="faint">CAT-BUG allows up to 6 dB. Lower is safer for your amp&apos;s headroom; some dips will stay.</p>
          </details>

          <div className={s.designBox} aria-live="polite">
            <p className={s.designLabel}>
              {rewActive ? <>EQ designed by <b>REW</b> (Match target)</> : <>EQ designed by <b>carcal</b>, updates as you move the faders</>}
            </p>
            {rewActive
              ? <button className="btn btn-quiet" onClick={() => setRew(null)}>Back to carcal&apos;s design</button>
              : <button className="btn btn-quiet" onClick={designWithRew} disabled={designing || !preview}>
                  {designing ? "REW is designing…" : rew ? "Design with REW again (target changed)" : "Design with REW (experimental)"}
                </button>}
          </div>

          <div className={s.applyBox}>
            <button className={`btn ${dirty || applying ? "btn-primary" : s.appliedBtn} ${s.apply}`} onClick={apply} disabled={applying || !shown || !dirty}>
              {applying ? "Applying to DSP…" : dirty ? "Apply to DSP" : "✓ Applied"}
            </button>
            {applying && <p className="faint">The bridge is loading it into the DSP and reading it back. This takes a few seconds.</p>}
            {!applying && !dirty && applied && <p className="faint">On the DSP since {new Date(applied.at + "Z").toLocaleString()}.</p>}
            {applyError && (
              <div className="notice error" role="alert">
                <p>{applyError}</p>
                {failedPreset && <p>The tune is saved. <a href={api.presetRewTxtUrl(id, failedPreset)} download>Download it as REW filters</a>, or load it from &quot;Applied before&quot; once the bridge is back.</p>}
              </div>
            )}
            {result && (
              <div className={`notice ${result.result.manual ? "" : result.result.verified === false ? "error" : "ok"}`}>
                <p>{describeLoad(result.result, "Applied and checked")}</p>
                {result.result.manual && <p><a href={api.presetFileUrl(id, result.preset.id)} download>Download the DSP file</a></p>}
                {[...result.result.warnings, ...result.result.ignored.filter((n) => !/delay .* not written/.test(n))].map((n) => <p key={n} className="dim">{n}</p>)}
              </div>
            )}
          </div>
        </aside>
      </div>

      <footer className={s.footer}>
        <button className="btn btn-quiet" onClick={remove}>Delete this car</button>
      </footer>
    </main>
  );
}
