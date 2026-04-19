export type KindInfo = {
  name: string;
  display_name: string;
  description: string;
  topology: "separate" | "combined";
  max_concurrent: number;
  active_sessions: number;
};

export type LivestreamStatus = "off" | "starting" | "on" | "error";
export type WorkerStatus = "off" | "starting" | "running" | "stopping" | "error";

export type SessionInfo = {
  id: string;
  kind: string;
  status: string;
  slot: number | null;
  stream_url: string | null;
  worker_status: WorkerStatus;
  livestream_status: LivestreamStatus;
  state: Record<string, unknown>;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};

export const BROKER_INTERNAL_URL =
  process.env.BROKER_URL || "http://broker:8080";

export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "claude-opus-4-7", label: "Opus 4.7 — highest quality" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5 (dated)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest / cheapest" },
];
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const API_KEY_STORAGE = "psychic-train:anthropic-key";
export const MODEL_STORAGE = "psychic-train:model";
