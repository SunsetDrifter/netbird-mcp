import type { IncomingHttpHeaders } from "node:http";
import type { NetBirdOAuthProvider } from "../oauth/provider.js";
import { authFromRequest, headerValue, RequestAuthOptions } from "./fromRequest.js";
import { AuthContext, AuthError } from "./context.js";

export interface AuthResolutionOptions extends RequestAuthOptions {
  /** Pass only when OAuth is enabled; Bearer tokens then resolve through it. */
  provider?: NetBirdOAuthProvider;
}

const BEARER_RE = /^Bearer\s+/i;

/**
 * Resolve a request to a NetBird AuthContext, or throw AuthError. The single
 * place that decides between the two ways a request can authenticate:
 *
 *   1. OAuth 2.1 (what Claude uses): `Authorization: Bearer <token>`, resolved
 *      through the OAuth provider's typed binding lookup.
 *   2. Direct PAT (handy for testing / simple deploys): the dedicated token
 *      header or `Authorization: Token <pat>`, resolved by authFromRequest.
 *
 * Bearer is reserved for OAuth. When no provider is supplied (OAuth disabled)
 * a Bearer token falls through to the direct-PAT path, which rejects it —
 * same rejection a caller with no credentials at all would see, just tagged
 * with the more specific "oauth_disabled" reason.
 */
export async function resolveAuth(
  headers: IncomingHttpHeaders,
  opts: AuthResolutionOptions = {},
): Promise<AuthContext> {
  const authz = headerValue(headers, "authorization");
  const bearerAttempted = authz !== undefined && BEARER_RE.test(authz);

  if (bearerAttempted && opts.provider) {
    const token = authz!.replace(BEARER_RE, "").trim();
    return opts.provider.resolveBinding(token);
  }

  try {
    return authFromRequest(headers, opts);
  } catch (err) {
    if (bearerAttempted && err instanceof AuthError) {
      throw new AuthError(err.message, "oauth_disabled");
    }
    throw err;
  }
}
