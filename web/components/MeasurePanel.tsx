"use client";

import { useEffect, useRef, useState } from "react";
import FreqChart from "@/components/FreqChart";
import MicGuide, { type Drive } from "@/components/MicGuide";
import { ApiError, api, describeLoad } from "@/lib/api";
import type { ApplyResult, Channel, Measurement } from "@/lib/types";
import s from "./MeasurePanel.module.css";

interface Props {
  pid: string;
  freqs: number[];
  mkey: string;                  // speaker key, or "noise"
  channel?: Channel;
  saved?: Measurement;
  noise?: Measurement;
  onSaved: (m: Measurement) => void;
  /** every speaker, for the cabin map */
  channels: Channel[];
  drive: Drive;
  onDriveChange?: (d: Drive) => void;
}

type Phase = "loading-dsp" | "ready" | "dsp-failed" | "recording" | "saving";

function snrOf(saved: number[], noise: number[], freqs: number[], ch?: Channel) {
  const lo = ch?.hp_hz ?? 20, hi = Math.min(ch?.lp_hz ?? 16000, 16000);
  const d = freqs.map((f, i) => (f >= lo && f <= hi ? saved[i] - noise[i] : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : null;
}

export default function MeasurePanel({ pid, freqs, mkey, channel, saved, noise, onSaved, channels, drive, onDriveChange }: Props) {
  const isNoise = mkey === "noise";
  const [phase, setPhase] = useState<Phase>("loading-dsp");
  const [dsp, setDsp] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsManual, setNeedsManual] = useState(false);
  const [live, setLive] = useState<{ spl: number[] | null; averages?: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // The parent remounts this panel per speaker (key=mkey), so state starts fresh.
  // Set the DSP up once per mount: only this speaker playing, or everything muted for
  // the noise floor. The ref stops React's dev-mode double effect loading it twice.
  const requested = useRef(false);
  const setUpDsp = () =>
    api.measureMode(pid, isNoise ? null : mkey)
      .then((r) => { setDsp(r); setPhase(r.applied || r.manual ? "ready" : "dsp-failed"); })
      .catch((e: Error) => { setError(e.message); setPhase("dsp-failed"); });

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    setUpDsp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => { setError(null); setPhase("loading-dsp"); setUpDsp(); };

  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
      api.rtaLive(pid).then((l) => setLive({ spl: l.spl, averages: l.averages })).catch(() => { /* live view is optional */ });
    }, 1000);
    return () => clearInterval(t);
  }, [phase, pid]);

  const start = async () => {
    setError(null); setNeedsManual(false);
    try { await api.rtaStart(pid); setElapsed(0); setPhase("recording"); }
    catch (e) { setError((e as Error).message); }
  };

  const save = async (how: "capture" | "pull") => {
    setPhase("saving"); setError(null);
    try {
      const m = how === "capture" ? await api.capture(pid, mkey) : await api.pull(pid, mkey);
      onSaved(m); setNeedsManual(false); setLive(null); setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.detail?.needs_manual_save) setNeedsManual(true);
      setError((e as Error).message);
      setPhase("ready");
    }
  };

  const upload = async (f: File) => {
    setError(null);
    try { onSaved(await api.uploadMeasurement(pid, mkey, f)); }
    catch (e) { setError((e as Error).message); }
  };

  const snr = saved && noise && !isNoise ? snrOf(saved.spl, noise.spl, freqs, channel) : null;
  const target = channel?.role === "sub" ? "40–50" : "80–100";
  const who = isNoise ? "every speaker muted" : `only ${channel?.label} playing`;
  const still = isNoise || channel?.role === "sub";

  return (
    <div className={s.panel}>
      <div className={s.top}>
      <div className={s.steps}>
        <ol>
          <li>
            {phase === "loading-dsp" && <>Setting the DSP to {who}…</>}
            {phase !== "loading-dsp" && dsp?.applied && (
              <>The DSP has {who}{dsp.verified === false ? " (it changed some values; check the DSP app)" : ""}.{" "}
                {isNoise ? "Keep the pink noise playing; nothing should come out of the speakers." : "Start the pink noise on your phone."}</>
            )}
            {dsp?.manual && (
              <>{describeLoad(dsp, "")} <a href={api.bridgeFileUrl(pid, dsp.file.id)} download>Download the preset</a> with {who}, import it, then continue.</>
            )}
            {phase === "dsp-failed" && <>Couldn&apos;t set the DSP up. <button className="btn btn-quiet" onClick={retry}>Try again</button></>}
          </li>
          {isNoise ? (
            <li>
              Keep the car quiet: engine off, doors closed, fan off. Put the mic on the driver&apos;s headrest where the
              middle of your head would be, at ear height and pointing at the roof, and leave it still.
            </li>
          ) : channel?.role === "sub" ? (
            <li>
              Tape or clamp the mic to the driver&apos;s headrest where the middle of your head would be, at ear height,
              pointing at the roof. Below 200 Hz a still mic measures the same as a moving one, so leave it there.
            </li>
          ) : (
            <li>
              Sit in the driver&apos;s seat. Hold the mic upright, pointing at the roof, and draw 2–3 circles the size of
              a tennis ball around one ear. Then move it over to the other ear and do the same. Keep going back and
              forth, spending the same time on each side.
            </li>
          )}
          <li>Record until the curve stops changing{isNoise ? ", about 15 seconds" : `: about ${target} averages`}.</li>
        </ol>
      </div>
      <MicGuide channels={channels} drive={drive} onDriveChange={onDriveChange}
                playing={isNoise ? null : mkey} technique={still ? "still" : "moving"} />
      </div>

      <div className={s.controls}>
        {phase === "recording" ? (
          <button className="btn btn-record is-live" onClick={() => save("capture")}>
            Stop and save <span className="num">{elapsed}s{live?.averages ? `, ${live.averages} averages` : ""}</span>
          </button>
        ) : (
          <button className="btn btn-record" onClick={start} disabled={phase === "loading-dsp" || phase === "saving" || phase === "dsp-failed"}>
            {phase === "saving" ? "Saving…" : saved ? "Record again" : "Start recording"}
          </button>
        )}
        {needsManual && <button className="btn" onClick={() => save("pull")}>Pull from REW</button>}
        <button className="btn btn-quiet" onClick={() => fileRef.current?.click()}>Upload a REW export</button>
        <input ref={fileRef} type="file" accept=".txt,.csv,.frd" hidden
               onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}
      {snr !== null && (
        <p className={`notice ${snr >= 20 ? "ok" : ""}`}>
          {snr >= 20
            ? `${snr.toFixed(0)} dB above the noise floor. Good.`
            : `Only ${snr.toFixed(0)} dB above the noise floor. CAT-BUG asks for 20 dB or more: turn the pink noise up and record again.`}
        </p>
      )}

      <FreqChart
        freqs={freqs}
        height={300}
        ariaLabel={`${isNoise ? "Noise floor" : channel?.label} measurement`}
        band={channel ? [channel.hp_hz ?? 20, channel.lp_hz ?? 20000] : null}
        traces={[
          { id: "live", label: "Live RTA", values: live?.spl, kind: "measured" },
          { id: "saved", label: isNoise ? "Noise floor" : "Saved measurement", values: saved?.spl, kind: isNoise ? "noise" : "predicted" },
          ...(!isNoise ? [{ id: "noise", label: "Noise floor", values: noise?.spl, kind: "noise" as const }] : []),
        ]}
      />
    </div>
  );
}
