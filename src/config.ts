/**
 * Central configuration. Only entrypoints (bin/*) read the environment; the rest
 * of the server receives resolved values so tool logic stays transport-agnostic.
 */

export const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ServerConfig {
  /** Enable destructive tools (delete_peer, delete_policy, delete_group). */
  enableDestructive: boolean;
  /** Client-side cap kept under NetBird Cloud's 120 req/min limit. */
  maxRequestsPerMinute: number;
  /** Per-request timeout for NetBird calls, in ms. */
  requestTimeoutMs: number;
  logLevel: LogLevel;
}

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const level = (env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(level)
    ? (level as LogLevel)
    : "info";

  return {
    enableDestructive: boolEnv(env.NETBIRD_ENABLE_DESTRUCTIVE, false),
    maxRequestsPerMinute: intEnv(env.NETBIRD_MAX_RPM, 110),
    requestTimeoutMs: intEnv(env.NETBIRD_TIMEOUT_MS, 30_000),
    logLevel,
  };
}

export function normalizeBaseUrl(url: string | undefined): string {
  const base = (url && url.trim()) || DEFAULT_NETBIRD_API_URL;
  return base.replace(/\/+$/, "");
}
