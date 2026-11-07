"use client";

import { useRef } from "react";
import s from "./Fader.module.css";

interface Props {
  label: string;
  hint: string;          // e.g. "100 Hz shelf"
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));

export default function Fader({ label, hint, value, onChange, min = -6, max = 6, step = 0.5 }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  const fromPointer = (clientY: number) => {
    const r = slot.current!.getBoundingClientRect();
    const t = 1 - (clientY - r.top) / r.height;
    onChange(clamp(min + t * (max - min)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    const delta = k === "ArrowUp" || k === "ArrowRight" ? step : k === "ArrowDown" || k === "ArrowLeft" ? -step
      : k === "PageUp" ? 2 : k === "PageDown" ? -2 : null;
    if (delta !== null) { e.preventDefault(); onChange(clamp(value + delta)); }
    else if (k === "Home") { e.preventDefault(); onChange(min); }
    else if (k === "End") { e.preventDefault(); onChange(max); }
    else if (k === "0") { e.preventDefault(); onChange(0); }
  };

  const ticks = [];
  for (let v = min; v <= max; v += 1) ticks.push(v);
  const zero = pct(0), cur = pct(value);

  return (
    <div className={s.fader}>
      <output className={`${s.readout} num`} aria-hidden="true">{fmt(value)}<span> dB</span></output>
      <div
        ref={slot}
        className={s.slot}
        role="slider"
        tabIndex={0}
        aria-label={`${label} (${hint})`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${fmt(value)} dB`}
        aria-orientation="vertical"
        onKeyDown={onKey}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e.clientY); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientY); }}
        onDoubleClick={() => onChange(0)}
      >
        {ticks.map((v) => (
          <span key={v} className={`${s.tick} ${v % 3 === 0 ? s.tickMajor : ""}`} style={{ bottom: `${pct(v)}%` }}>
            {v % 3 === 0 && <em>{v > 0 ? `+${v}` : v}</em>}
          </span>
        ))}
        <span className={s.track} />
        <span className={s.fill} style={{ bottom: `${Math.min(zero, cur)}%`, height: `${Math.abs(cur - zero)}%` }} />
        <span className={s.cap} style={{ bottom: `${cur}%` }} />
      </div>
      <div className={s.label}>{label}</div>
      <div className={s.hint}>{hint}</div>
    </div>
  );
}
