/**
 * Preset contract v1 ("carcal.preset/1"): what the dashboard and a DSP bridge exchange.
 * Mirrors carcal/bridge/contract.py; the JSON Schema is contract/preset-v1.schema.json.
 * The dashboard never sees device-specific details beyond these generic capabilities.
 */
import type { Filter } from "./engine/dsp";

export const CONTRACT = "carcal.preset/1";

export interface Crossover { hz: number; slope_db_oct?: number | null; type?: string | null }

export interface ChannelInfo {
  key: string;
  label: string;
  role: "front" | "rear" | "sub" | "center" | "other";
  pair: string | null;
  default_highpass: Crossover | null;
  default_lowpass: Crossover | null;
  default_level_offset_db: number;
}

export interface EqCapability {
  kind: "fixed" | "parametric";
  bands_hz: number[] | null;
  q: number | null;
  q_range: [number, number] | null;
  max_filters: number;
  gain_db: [number, number];
  gain_step_db: number;
  filter_types: string[];
  fs_hz: number;
}

export interface SettingCapability { supported: boolean; writable: boolean; note: string | null }

export interface DeviceDescription {
  contract: string;
  bridge_version: string;
  mode: "real" | "sim";
  device: { id: string; maker: string; name: string };
  status: { automation: boolean; app_found: boolean | null; amp_connected: boolean | null; message: string | null };
  channels: ChannelInfo[];
  capabilities: {
    eq: EqCapability;
    crossover_slopes_db_oct: number[];
    crossover_types: string[];
    delay: SettingCapability;
    gain: SettingCapability;
    polarity: SettingCapability;
    mute: SettingCapability;
  };
  baseline: { source: "captured" | "uploaded" | "factory default"; at: string | null };
}

export interface ChannelSettings {
  mute?: boolean;
  gain_db?: number;
  delay_ms?: number;
  polarity?: "normal" | "inverted";
  highpass?: Crossover | null;      // null = no filter; absent = keep baseline
  lowpass?: Crossover | null;
  eq?: { filters?: Filter[]; rew_txt?: string } | null;  // null or [] = flat
}

export interface PresetRequest {
  contract: typeof CONTRACT;
  name: string;
  purpose: "tune" | "measure" | "test";
  channels: Record<string, ChannelSettings>;
}

export interface ChannelCompile {
  eq_response_db: number[];
  eq_exact: boolean;
  fit_rms_db: number;
  fit_max_db: number;
  warnings: string[];
}

export interface CompileResult {
  contract: string;
  preset_id: string;
  freqs: number[];
  channels: Record<string, ChannelCompile>;
  ignored: string[];
  warnings: string[];
  file: { id: string; name: string; url: string };
}

export interface ApplyResult extends CompileResult {
  applied: boolean;
  manual: boolean;
  verified: boolean | null;
  mismatches: string[];
  backup_id: string | null;
  message: string | null;
}

export interface RestoreResult {
  restored: boolean;
  manual: boolean;
  what: string;
  verified?: boolean;
  mismatches?: string[];
  message?: string;
}
