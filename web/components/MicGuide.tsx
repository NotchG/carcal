"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import type { Channel } from "@/lib/types";
import s from "./MicGuide.module.css";

/*
 * Illustrations for the guided measurements (CAT-BUG 5.2):
 *  - CabinMap: the car from above, which speaker is playing, where the mic goes.
 *  - MicTechnique: the listener seen from the windscreen, with the mic's movement.
 *    Moving mic method: upright (pointing at the roof), 2-3 tennis-ball circles around
 *    one ear, over to the other ear, repeat. Subwoofer and noise floor: mic held still.
 * Animations are SVG (SMIL), so the ear highlight and the caption stay in step with
 * the mic. Reduced motion gets the same picture without movement.
 */

export type Drive = "rhd" | "lhd";
export type Technique = "moving" | "still";

const reduceQuery = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(reduceQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(reduceQuery).matches,
    () => false,
  );
}

/* ---------------- cabin map (top view, front at the top) ---------------- */

const SEAT_X = { left: 88, right: 152 };
const HEAD_Y = 202;

function sideOf(c: Channel): "left" | "right" | null {
  const t = `${c.key} ${c.label}`.toLowerCase();
  if (/\bleft\b|^[a-z]*l\b/.test(t)) return "left";
  if (/\bright\b|^[a-z]*r\b/.test(t)) return "right";
  return null;
}

/** Where a speaker sits on the map, or null if the map can't place it. */
export function speakerSpot(c: Channel): [number, number] | null {
  const side = sideOf(c);
  const x = side === "left" ? 46 : side === "right" ? 194 : 120;
  if (c.role === "front") return [x, 170];
  if (c.role === "rear") return [x, 262];
  if (c.role === "sub") return [120, 331];
  if (c.role === "center") return [120, 104];
  return null;
}

interface CabinProps {
  channels: Channel[];
  drive: Drive;
  /** measure: `playing` is the one speaker on (null = all muted). distances: tape lines to each speaker. */
  mode: "measure" | "distances";
  playing?: string | null;
  technique?: Technique;
  focusKey?: string | null;
  distances?: Record<string, number | null | undefined>;
}

export function CabinMap({ channels, drive, mode, playing = null, technique = "moving", focusKey, distances }: CabinProps) {
  const cx = drive === "rhd" ? SEAT_X.right : SEAT_X.left;
  const otherX = drive === "rhd" ? SEAT_X.left : SEAT_X.right;
  const seated = mode === "distances" || technique === "moving";
  const placed = channels.map((c) => ({ c, at: speakerSpot(c) })).filter((x): x is { c: Channel; at: [number, number] } => !!x.at);
  const playingCh = channels.find((c) => c.key === playing);
  const title = mode === "distances"
    ? "Top view of the car: measure from the middle of your head in the driver's seat to each speaker"
    : `Top view of the car: ${playingCh ? `only ${playingCh.label} playing` : "every speaker muted"}, mic at the driver's seat`;

  return (
    <svg viewBox="0 0 240 380" className={s.cabin} role="img" aria-label={title}>
      <path className={s.body} d="M 78 22 Q 120 10 162 22 Q 200 34 200 84 L 200 334 Q 200 364 170 366 L 70 366 Q 40 364 40 334 L 40 84 Q 40 34 78 22 Z" />
      <path className={s.glass} d="M 54 98 Q 120 82 186 98" />
      <path className={s.glass} d="M 58 308 Q 120 320 182 308" />
      <text x={120} y={58} className={s.mapLabel} textAnchor="middle">Front</text>

      {/* seats */}
      {[cx, otherX].map((x) => (
        <g key={x}>
          <rect className={s.seat} x={x - 22} y={148} width={44} height={50} rx={8} />
          <rect className={s.seat} x={x - 24} y={198} width={48} height={14} rx={5} />
        </g>
      ))}
      <rect className={s.seat} x={60} y={240} width={120} height={44} rx={8} />
      <rect className={s.seat} x={58} y={284} width={124} height={12} rx={5} />
      <ellipse className={s.wheel} cx={cx} cy={128} rx={15} ry={5} />

      {/* the listener (or where their head would be) */}
      {seated ? (
        <g>
          <ellipse className={s.person} cx={cx} cy={HEAD_Y + 8} rx={20} ry={8} />
          <circle className={s.person} cx={cx} cy={HEAD_Y} r={10} />
          <circle className={s.person} cx={cx - 10.5} cy={HEAD_Y} r={2.6} />
          <circle className={s.person} cx={cx + 10.5} cy={HEAD_Y} r={2.6} />
        </g>
      ) : (
        <circle className={s.ghost} cx={cx} cy={HEAD_Y} r={10} />
      )}

      {/* tape lines for distances */}
      {mode === "distances" && placed.map(({ c, at: [x, y] }) => {
        const d = distances?.[c.key];
        // label nearer the speaker end, so labels don't pile up around the head
        const mx = cx + (x - cx) * 0.64, my = HEAD_Y + (y - HEAD_Y) * 0.64;
        return (
          <g key={c.key} className={c.key === focusKey ? s.tapeFocus : s.tape}>
            <line x1={cx} y1={HEAD_Y} x2={x} y2={y} />
            {d ? <text x={mx} y={my - 4} textAnchor="middle" className={s.tapeLabel}>{d} cm</text> : null}
          </g>
        );
      })}

      {/* speakers */}
      {placed.map(({ c, at: [x, y] }) => {
        const on = mode === "measure" && c.key === playing;
        const muted = mode === "measure" && !on;
        const lx = x < 100 ? 26 : x > 140 ? 214 : c.role === "sub" ? 146 : 120;
        const anchor = x < 100 ? "end" : x > 140 ? "start" : c.role === "sub" ? "start" : "middle";
        return (
          <g key={c.key}>
            {c.role === "sub" && <rect className={s.subBox} x={100} y={318} width={40} height={26} rx={3} />}
            {on && (
              <>
                <circle className={s.ring} cx={x} cy={y} r={7} />
                <circle className={`${s.ring} ${s.ring2}`} cx={x} cy={y} r={7} />
              </>
            )}
            <circle className={on ? s.spkOn : muted ? s.spkMuted : s.spk} cx={x} cy={y} r={7} />
            {muted && <line className={s.muteSlash} x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} />}
            <text x={lx} y={c.role === "center" ? y - 12 : y + 5} textAnchor={anchor}
                  className={on ? s.mapLabelOn : s.mapLabel}>{c.key}</text>
          </g>
        );
      })}

      {/* mic */}
      {mode === "measure" && (
        <g>
          {technique === "moving" && <ellipse className={s.orbit} cx={cx} cy={HEAD_Y} rx={22} ry={13} />}
          <circle className={s.micDot} cx={technique === "moving" ? cx - 20 : cx} cy={HEAD_Y} r={4} />
        </g>
      )}
    </svg>
  );
}

/* ---------------- mic technique (front view) ---------------- */

// Ear circles (r 15, a tennis ball next to a ~15 cm head) and the hop over the head
// (half circle, r 42). Path lengths: 3 circles = 282.7, hop = 131.9, so with paced
// motion the phases change at these fractions of the loop:
const T_LEFT_END = 0.341, T_HALF = 0.5, T_RIGHT_END = 0.841;
const DUR = "13s";
const CIRCLE_L = "a 15 15 0 1 0 0 30 a 15 15 0 1 0 0 -30 ";
const CIRCLE_R = "a 15 15 0 1 1 0 30 a 15 15 0 1 1 0 -30 ";
const MOTION = `M 118 111 ${CIRCLE_L.repeat(3)}A 42 42 0 0 1 202 111 ${CIRCLE_R.repeat(3)}A 42 42 0 0 0 118 111`;

function Mic({ x = 0, y = 0 }: { x?: number; y?: number }) {
  // drawn with the capsule tip at (0, 0); it only ever translates, so it stays upright
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className={s.upArrow} d="M -5 -7 L 0 -12 L 5 -7" />
      <rect className={s.capsule} x={-4.5} y={0} width={9} height={7} rx={2} />
      <rect className={s.micBody} x={-3.5} y={7} width={7} height={34} rx={2} />
      <path className={s.cable} d="M 0 41 q 0 12 6 18" />
    </g>
  );
}

function Phase({ text, values, keyTimes, initial, animate }: { text: string; values: string; keyTimes: string; initial: number; animate: boolean }) {
  return (
    <text x={160} y={290} textAnchor="middle" className={s.phase} opacity={initial}>
      {text}
      {animate && <animate attributeName="opacity" values={values} keyTimes={keyTimes} calcMode="discrete" dur={DUR} repeatCount="indefinite" />}
    </text>
  );
}

export function MicTechnique({ technique, svgRef }: { technique: Technique; svgRef?: React.Ref<SVGSVGElement> }) {
  const reduced = useReducedMotion();
  const moving = technique === "moving";
  const animate = moving && !reduced;
  const title = moving
    ? "Front view: the mic is held upright, pointing at the roof, and circles one ear two or three times, then moves over the head to the other ear and circles it, and back again."
    : "Front view: the mic is fixed to the headrest at ear height, where the middle of your head would be, pointing at the roof, and doesn't move.";

  return (
    <svg ref={svgRef} viewBox="0 0 320 296" className={s.technique} role="img" aria-label={title}>
      <path className={s.roof} d="M 8 26 Q 160 4 312 26" />
      <text x={160} y={32} textAnchor="middle" className={s.mapLabel}>Roof</text>

      {/* seat */}
      <rect className={s.seat} x={96} y={152} width={128} height={120} rx={20} />
      <rect className={s.seat} x={140} y={136} width={4} height={18} />
      <rect className={s.seat} x={176} y={136} width={4} height={18} />
      <rect className={s.seat} x={128} y={88} width={64} height={52} rx={14} />

      {moving ? (
        <g>
          <path className={s.person} d="M 92 272 C 92 214 116 196 148 190 L 172 190 C 204 196 228 214 228 272 Z" />
          <rect className={s.person} x={149} y={150} width={22} height={44} rx={8} />
          <ellipse className={s.person} cx={160} cy={122} rx={32} ry={40} />
          <ellipse className={s.person} cx={127} cy={126} rx={5} ry={10} />
          <ellipse className={s.person} cx={193} cy={126} rx={5} ry={10} />

          {/* path the mic follows */}
          <circle className={s.trail} cx={118} cy={126} r={15} />
          <circle className={s.trail} cx={202} cy={126} r={15} />
          <path className={s.trail} d="M 118 111 A 42 42 0 0 1 202 111" />
          <path className={s.trailArrow} d="M 99 122 L 103 128 L 107 122" />
          <path className={s.trailArrow} d="M 213 122 L 217 128 L 221 122" />

          {/* the ear being circled lights up */}
          <ellipse className={s.earOn} cx={127} cy={126} rx={8} ry={13} opacity={animate ? 1 : 0}>
            {animate && <animate attributeName="opacity" values="1;0" keyTimes={`0;${T_LEFT_END}`} calcMode="discrete" dur={DUR} repeatCount="indefinite" />}
          </ellipse>
          <ellipse className={s.earOn} cx={193} cy={126} rx={8} ry={13} opacity={0}>
            {animate && <animate attributeName="opacity" values="0;1;0" keyTimes={`0;${T_HALF};${T_RIGHT_END}`} calcMode="discrete" dur={DUR} repeatCount="indefinite" />}
          </ellipse>

          {animate ? (
            <g>
              <Mic />
              <animateMotion dur={DUR} repeatCount="indefinite" path={MOTION} rotate="0" />
            </g>
          ) : (
            <Mic x={103} y={126} />
          )}

          {animate ? (
            <>
              <Phase text="Circles around one ear" values="1;0" keyTimes={`0;${T_LEFT_END}`} initial={1} animate />
              <Phase text="Over to the other ear" values="0;1;0" keyTimes={`0;${T_LEFT_END};${T_HALF}`} initial={0} animate />
              <Phase text="Circles around the other ear" values="0;1;0" keyTimes={`0;${T_HALF};${T_RIGHT_END}`} initial={0} animate />
              <Phase text="Back again, and repeat" values="0;1" keyTimes={`0;${T_RIGHT_END}`} initial={0} animate />
            </>
          ) : (
            <text x={160} y={290} textAnchor="middle" className={s.phase}>Circle one ear, then the other, and repeat</text>
          )}
        </g>
      ) : (
        <g>
          <ellipse className={s.ghost} cx={160} cy={122} rx={32} ry={40} />
          <line className={s.ghost} x1={128} y1={126} x2={192} y2={126} />
          <Mic x={160} y={119} />
          <rect className={s.tapeStrap} x={150} y={130} width={20} height={7} rx={1.5} />
          <path className={s.leader} d="M 192 100 L 214 88" />
          <text x={218} y={84} className={s.note}>Where your head</text>
          <text x={218} y={99} className={s.note}>would be</text>
          <text x={160} y={290} textAnchor="middle" className={s.phase}>Still, at ear height, pointing at the roof</text>
        </g>
      )}
    </svg>
  );
}

/* ---------------- the two together, for a measurement step ---------------- */

interface GuideProps {
  channels: Channel[];
  drive: Drive;
  onDriveChange?: (d: Drive) => void;
  playing: string | null;
  technique: Technique;
}

export default function MicGuide({ channels, drive, onDriveChange, playing, technique }: GuideProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const playingCh = channels.find((c) => c.key === playing);

  const togglePause = () => {
    const el = svg.current;
    if (!el) return;
    if (paused) el.unpauseAnimations(); else el.pauseAnimations();
    setPaused(!paused);
  };

  return (
    <div className={`${s.guide} ${paused ? s.paused : ""}`}>
      <figure className={s.fig}>
        <CabinMap channels={channels} drive={drive} mode="measure" playing={playing} technique={technique} />
        <figcaption className={s.cap}>
          <span>{playingCh ? `Only ${playingCh.label} playing` : "Every speaker muted"}</span>
          {onDriveChange && (
            <span className={s.seg} role="group" aria-label="Steering wheel side">
              <button type="button" aria-pressed={drive === "lhd"} onClick={() => onDriveChange("lhd")}>Wheel left</button>
              <button type="button" aria-pressed={drive === "rhd"} onClick={() => onDriveChange("rhd")}>Wheel right</button>
            </span>
          )}
        </figcaption>
      </figure>
      <figure className={s.fig}>
        <MicTechnique technique={technique} svgRef={svg} />
        <figcaption className={s.cap}>
          <span>{technique === "moving" ? "Seen from the windscreen. The mic stays upright the whole time." : "Seen from the windscreen. The mic stays put."}</span>
          {technique === "moving" && !reduced && (
            <button type="button" className={s.pause} onClick={togglePause}>{paused ? "Play" : "Pause"}</button>
          )}
        </figcaption>
      </figure>
    </div>
  );
}
