/**
 * Central configuration. All environment parsing happens behind loadServerConfig();
 * entrypoints (bin/*) call it and pass resolved values everywhere else, so tool
 * logic and transport wiring stay transport-agnostic.
 */

export const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";
/** Client-side cap kept under NetBird Cloud's 120 req/min limit. */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 110;
/** Per-request timeout for NetBird calls, in ms. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default header carrying a direct NetBird PAT (fallback auth path). */
export const DEFAULT_TOKEN_HEADER = "x-netbird-token";
/** Default header carrying a self-hosted management API base URL. */
export const DEFAULT_URL_HEADER = "x-netbird-api-url";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** HTTP (cloud) entrypoint settings — unused by the stdio entrypoint. */
export interface HttpConfig {
  /** Port the Streamable HTTP server listens on. */
  port: number;
  /** Header carrying a direct NetBird PAT (fallback auth path). */
  tokenHeader: string;
  /** Header carrying a per-tenant NetBird base URL override. */
  urlHeader: string;
  /** Whether the OAuth 2.1 authorization server is mounted. */
  oauthEnabled: boolean;
  /** Externally reachable origin the AS advertises in its metadata. */
  publicBaseUrl: string;
  /** Whether a PAT is verified against NetBird at OAuth login time. */
  verifyPatOnLogin: boolean;
}

export interface ServerConfig {
  /** Enable destructive tools (delete_peer, delete_policy, delete_group). */
  enableDestructive: boolean;
  /** Client-side cap kept under NetBird Cloud's 120 req/min limit. */
  maxRequestsPerMinute: number;
  /** Per-request timeout for NetBird calls, in ms. */
  requestTimeoutMs: number;
  logLevel: LogLevel;
  http: HttpConfig;
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

  // Port is resolved first: the public base URL default is derived from it.
  // intEnv guards malformed values — a garbage PORT must not yield NaN here
  // (it would poison the derived publicBaseUrl and the listen call).
  const port = intEnv(env.PORT, 3000);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");

  return {
    enableDestructive: boolEnv(env.NETBIRD_ENABLE_DESTRUCTIVE, false),
    maxRequestsPerMinute: intEnv(env.NETBIRD_MAX_RPM, DEFAULT_MAX_REQUESTS_PER_MINUTE),
    requestTimeoutMs: intEnv(env.NETBIRD_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    logLevel,
    http: {
      port,
      tokenHeader: env.NETBIRD_TOKEN_HEADER ?? DEFAULT_TOKEN_HEADER,
      urlHeader: env.NETBIRD_URL_HEADER ?? DEFAULT_URL_HEADER,
      oauthEnabled: boolEnv(env.NETBIRD_ENABLE_OAUTH, true),
      publicBaseUrl,
      verifyPatOnLogin: boolEnv(env.NETBIRD_VERIFY_PAT_ON_LOGIN, true),
    },
  };
}

export function normalizeBaseUrl(url: string | undefined): string {
  const base = (url && url.trim()) || DEFAULT_NETBIRD_API_URL;
  return base.replace(/\/+$/, "");
}
