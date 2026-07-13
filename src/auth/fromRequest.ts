import type { IncomingHttpHeaders } from "node:http";
import { normalizeBaseUrl } from "../config.js";
import { AuthContext, AuthError } from "./context.js";

export interface RequestAuthOptions {
  /**
   * Header carrying the caller's NetBird PAT. Required — the default lives in
   * config.ts (NETBIRD_TOKEN_HEADER) and is threaded in by the entrypoint, so
   * this module never carries a fallback of its own.
   */
  tokenHeader: string;
  /**
   * Header for a per-tenant API base URL override. Required — its default also
   * lives in config.ts (NETBIRD_URL_HEADER); no fallback is defined here.
   */
  urlHeader: string;
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Cloud (HTTP) auth: resolve the tenant's credential from the request, per call.
 * The token is used only for the life of the request and is never persisted,
 * which keeps the hosted server multi-tenant and stateless.
 *
 * Accepts the dedicated token header or a standard `Authorization: Token <pat>` header.
 * NOTE: `Authorization: Bearer <...>` is intentionally NOT accepted here — Bearer is
 * reserved for OAuth access tokens, which are resolved separately via the OAuth store.
 *
 * This direct-PAT path stays available (handy for local HTTP testing and simple
 * single-tenant deploys) alongside the OAuth flow that Claude uses.
 */
export function authFromRequest(
  headers: IncomingHttpHeaders,
  opts: RequestAuthOptions,
): AuthContext {
  const { tokenHeader, urlHeader } = opts;

  const authz = headerValue(headers, "authorization")?.trim();
  let token = headerValue(headers, tokenHeader)?.trim();
  if (!token && authz && /^Token\s+/i.test(authz)) {
    token = authz.replace(/^Token\s+/i, "").trim();
  }
  if (!token) {
    throw new AuthError(
      `Missing NetBird token. Provide it in the "${tokenHeader}" header or as ` +
        `"Authorization: Token <pat>".`,
      authz ? "wrong_scheme" : "missing_credentials",
    );
  }

  return { token, baseUrl: normalizeBaseUrl(headerValue(headers, urlHeader)) };
}
