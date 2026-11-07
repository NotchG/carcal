"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import s from "./FreqChart.module.css";

export type TraceKind = "target" | "predicted" | "measured" | "noise" | "eq";

export interface Trace {
  id: string;
  label: string;
  values: number[] | null | undefined;
  kind: TraceKind;
}

interface Props {
  freqs: number[];
  traces: Trace[];
  height?: number;
  yRange?: [number, number];
  band?: [number, number] | null;      // shaded frequency range (e.g. the EQ range)
  zeroLine?: boolean;
  ariaLabel: string;
  unit?: string;
}

const F_MIN = 20, F_MAX = 20000;
const L0 = Math.log10(F_MIN), L1 = Math.log10(F_MAX);
const MAJOR = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const MINOR = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000];
const PAD = { l: 44, r: 12, t: 10, b: 26 };

const fmtF = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

export default function FreqChart({ freqs, traces, height = 360, yRange, band, zeroLine, ariaLabel, unit = "dB" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = width - PAD.l - PAD.r;
  const h = height - PAD.t - PAD.b;
  const x = (f: number) => PAD.l + ((Math.log10(f) - L0) / (L1 - L0)) * w;

  const [y0, y1] = useMemo(() => {
    if (yRange) return yRange;
    const vals = traces.flatMap((t) => t.values ?? []).filter((v) => Number.isFinite(v));
    if (!vals.length) return [40, 100];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const step = 5;
    return [Math.floor((lo - 3) / step) * step, Math.ceil((hi + 3) / step) * step];
  }, [traces, yRange]);
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * h;
  const yStep = y1 - y0 > 50 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) yTicks.push(v);

  const path = (vals: number[]) => {
    let d = "", pen = false;
    for (let i = 0; i < freqs.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      const cv = Math.min(y1, Math.max(y0, v));
      d += `${pen ? "L" : "M"}${x(freqs[i]).toFixed(1)},${y(cv).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < PAD.l || px > PAD.l + w || !freqs.length) return setHover(null);
    const f = 10 ** (L0 + ((px - PAD.l) / w) * (L1 - L0));
    let best = 0;
    for (let i = 1; i < freqs.length; i++) if (Math.abs(freqs[i] - f) < Math.abs(freqs[best] - f)) best = i;
    setHover(best);
  };

  const shown = traces.filter((t) => t.values && t.values.length === freqs.length);
  const order: TraceKind[] = ["noise", "measured", "eq", "predicted", "target"];
  const sorted = [...shown].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  return (
    <div ref={wrap} className={s.wrap}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}
           onPointerMove={onMove} onPointerLeave={() => setHover(null)} className={s.svg}>
        {band && (
          <rect x={x(Math.max(F_MIN, band[0]))} y={PAD.t}
                width={Math.max(0, x(Math.min(F_MAX, band[1])) - x(Math.max(F_MIN, band[0])))}
                height={h} className={s.band} />
        )}
        {MINOR.map((f) => <line key={f} x1={x(f)} x2={x(f)} y1={PAD.t} y2={PAD.t + h} className={s.gridMinor} />)}
        {MAJOR.map((f) => (
          <g key={f}>
            <line x1={x(f)} x2={x(f)} y1={PAD.t} y2={PAD.t + h} className={s.grid} />
            <text x={x(f)} y={height - 8} className={s.tick} textAnchor="middle">{fmtF(f)}</text>
          </g>
        ))}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={PAD.l + w} y1={y(v)} y2={y(v)} className={v === 0 && zeroLine ? s.zero : s.grid} />
            <text x={PAD.l - 8} y={y(v) + 4} className={s.tick} textAnchor="end">{v}</text>
          </g>
        ))}
        {sorted.map((t) => <path key={t.id} d={path(t.values!)} className={`${s.trace} ${s[t.kind]}`} />)}
        {hover !== null && (
          <line x1={x(freqs[hover])} x2={x(freqs[hover])} y1={PAD.t} y2={PAD.t + h} className={s.cursor} />
        )}
      </svg>

      <div className={s.legend}>
        {shown.map((t) => (
          <span key={t.id} className={s.key}>
            <span className={`${s.swatch} ${s[t.kind]}`} />
            {t.label}
            {hover !== null && Number.isFinite(t.values![hover]) && (
              <span className="num"> {t.values![hover].toFixed(1)} {unit}</span>
            )}
          </span>
        ))}
        {hover !== null && <span className={`${s.key} num`}>{fmtF(freqs[hover])} Hz</span>}
      </div>
    </div>
  );
}
