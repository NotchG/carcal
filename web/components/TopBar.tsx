"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Health } from "@/lib/types";
import s from "./TopBar.module.css";

export function useHealth(intervalMs = 10000) {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api.health()
        .then((h) => { if (alive) { setHealth(h); setDown(false); } })
        .catch(() => { if (alive) setDown(true); });
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [intervalMs]);
  return { health, down };
}

export default function TopBar() {
  const { health, down } = useHealth();
  return (
    <header className={s.bar}>
      <Link href="/" className={s.mark} aria-label="carcal home">
        <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
          <path d="M1 12 C 7 12, 9 3, 15 3 S 23 11, 28 9 S 35 5, 39 5" fill="none"
                stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        carcal
      </Link>
      <div className={s.status} role="status" aria-live="polite">
        {down ? (
          <span className={s.item}><span className="dot bad" /> carcal server not responding</span>
        ) : (
          <>
            <span className={s.item} title={health?.rew.error ?? health?.rew.url}>
              <span className={`dot ${health ? (health.rew.connected ? "ok" : "bad") : ""}`} /> REW
            </span>
            {health?.bridges.map((b) => {
              const amp = b.status?.amp_connected;
              const tone = !b.ok ? "bad" : !b.status?.automation || amp === false ? "warn" : "ok";
              const label = !b.ok ? "offline" : !b.status?.automation ? "manual import" : amp === false ? "amp not connected" : "";
              return (
                <span key={b.id} className={s.item} title={b.error ?? b.url}>
                  {b.mode === "sim" && <span className={s.sim}>Simulated</span>}
                  <span className={`dot ${tone}`} /> {b.name}{label ? `: ${label}` : ""}
                </span>
              );
            })}
            {health && !health.bridges.length && <span className={s.item}><span className="dot" /> No DSP bridge yet</span>}
          </>
        )}
      </div>
    </header>
  );
}
