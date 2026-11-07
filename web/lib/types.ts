import type { ApplyResult, DeviceDescription, RestoreResult } from "./contract";
import type { TargetSpec, Tone } from "./engine/curves";
import type { Filter } from "./engine/dsp";
import type { CalSettings, ChannelDef, ChannelResult } from "./engine/engine";

export type { ApplyResult, CalSettings, ChannelDef as Channel, ChannelResult, DeviceDescription, Filter, RestoreResult, TargetSpec, Tone };

export interface Car { make: string; model: string; year: string; drive?: "rhd" | "lhd" }

export interface BridgeInfo { id: string; name: string; url: string; device: { id: string; maker: string; name: string } | null; mode: "real" | "sim" | null; last_ok: string | null }

export interface PresetEntry {
  id: string; at: string; name: string; design: "carcal" | "rew";
  target: TargetSpec; settings: CalSettings; applied: boolean; verified: boolean | null;
  result: Pick<ApplyResult, "manual" | "file" | "ignored" | "warnings" | "mismatches" | "message"> | null;
}

export interface ProfileSummary {
  id: string; name: string; car: Car; device_name: string; bridge: string | null;
  setup_complete: boolean; measured: string[]; missing: string[]; stale: string[];
  last_applied: PresetEntry | null; updated: string;
}

export interface Profile {
  id: string; name: string; car: Car; bridge_id: string; device: DeviceDescription;
  channels: ChannelDef[]; target: TargetSpec; settings: CalSettings;
  setup_complete: boolean; last_applied: PresetEntry | null; summary: ProfileSummary;
}

export interface HouseCurve { id: string; label: string; description: string; curve: number[] }

export interface Preview {
  freqs: number[];
  system_target: number[];
  system_estimate: number[];
  reference_level_db: number;
  channels: Record<string, ChannelResult>;
  delays_ms: Record<string, number>;
  design: "carcal" | "rew";
  stale: string[];
  eq_kind: "fixed" | "parametric";
  delay_writable: boolean;
  warnings: string[];
}

export interface Measurement {
  key: string; spl: number[]; meta: Record<string, unknown>;
  crossovers: { hp_hz: number | null; lp_hz: number | null } | null; taken: string; stale: boolean;
}

export interface Health {
  rew: { connected: boolean; url: string; error?: string };
  bridges: { id: string; name: string; url: string; ok: boolean; mode?: "real" | "sim"; device?: string;
             status?: DeviceDescription["status"]; error?: string }[];
}

export interface ApplyResponse { preset: PresetEntry; result: ApplyResult; delays_ms: Record<string, number>; delay_writable: boolean }
