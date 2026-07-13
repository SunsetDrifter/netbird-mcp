import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  normalizeBaseUrl,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../config.js";
import type { Logger } from "../logger.js";
import { AuthContext, AuthError } from "../auth/context.js";
import { NetBirdClient, type TokenVerification } from "../netbird/client.js";
import { RateLimiter } from "../netbird/rateLimiter.js";
import { ACCESS_TTL_SECONDS, OAuthStore, type NetBirdBinding } from "./store.js";
import type { LoginPageParams } from "./loginPage.js";

export interface OAuthCoreOptions {
  logger: Logger;
  /** Verify a NetBird PAT during login by making a cheap read call. */
  verifyPatOnLogin?: boolean;
  fetchImpl?: typeof fetch;
}

/** Raw inputs to the authorization decision — one per OAuthServerProvider#authorize call. */
export interface BeginAuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
  resource?: string;
}

/** Raw form fields posted from the login page. All optional: the form is untrusted input. */
export interface LoginSubmission {
  clientId?: string;
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  scope?: string;
  resource?: string;
  netbirdToken?: string;
  netbirdApiUrl?: string;
}

/** The OAuth params the login page must echo back, whichever decision follows. */
export type LoginPrefill = LoginPageParams;

export type OAuthChallenge = { kind: "challenge" } & LoginPrefill;
export type OAuthLoginError = { kind: "error"; reason: string } & LoginPrefill;
export type OAuthRedirect = { kind: "redirect"; location: string };

export type BeginAuthorizeResult = OAuthChallenge | OAuthLoginError;
export type CompleteLoginResult = OAuthRedirect | OAuthLoginError;

/**
 * Framework-free OAuth 2.1 core for the NetBird connector. Owns the authorization
 * decision, the login-completion decision, and the token protocol (code exchange,
 * refresh rotation, verification, revocation). Nothing here knows about HTTP —
 * inputs are plain values and outputs are explicit discriminated results; the web
 * adapter (NetBirdOAuthProvider) is the only thing that talks req/res.
 *
 * Claude registers dynamically (RFC 7591) and drives an authorization-code + PKCE
 * flow. `beginAuthorize` decides whether to show the login challenge (where a user
 * pastes a NetBird PAT); `completeLogin` verifies it and binds the issued code to
 * it. Tool code never sees OAuth — it only ever receives a resolved AuthContext via
 * resolveBinding.
 */
export class OAuthCore {
  private readonly store = new OAuthStore();
  private readonly logger: Logger;
  private readonly verifyPat: boolean;
  private readonly fetchImpl: typeof fetch;
  // Shared across all logins so a burst of login attempts is throttled as one
  // stream, not one fresh (and therefore never-tripping) limiter per attempt.
  private readonly verifyLimiter = new RateLimiter(DEFAULT_MAX_REQUESTS_PER_MINUTE);

  constructor(opts: OAuthCoreOptions) {
    this.logger = opts.logger;
    this.verifyPat = opts.verifyPatOnLogin ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // --- dynamic client registration (backs the adapter's clientsStore) ---

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(client: OAuthClientInformationFull): void {
    this.store.saveClient(client);
  }

  // --- authorization decision ---

  /**
   * Decides what /authorize should do: render the login challenge, or reject
   * before anything is rendered. Client lookup, redirect-URI registration, and
   * PKCE presence are all validated here — the SDK's own authorize handler
   * already checks client/redirect_uri before calling in, so in practice this
   * only ever yields "challenge"; the error branch is defense in depth and the
   * seam a test can drive directly.
   */
  beginAuthorize(params: BeginAuthorizeParams): BeginAuthorizeResult {
    const prefill: LoginPrefill = {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      state: params.state ?? "",
      codeChallenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(" "),
      resource: params.resource ?? "",
    };

    const client = this.store.getClient(params.clientId);
    if (!client) {
      return { kind: "error", reason: "Unknown OAuth client.", ...prefill };
    }
    if (!params.redirectUri || !client.redirect_uris.includes(params.redirectUri)) {
      return {
        kind: "error",
        reason: "The redirect target is not registered for this client.",
        ...prefill,
      };
    }
    if (!params.codeChallenge) {
      return { kind: "error", reason: "Missing PKCE code challenge.", ...prefill };
    }
    return { kind: "challenge", ...prefill };
  }

  // --- login completion ---

  /**
   * Validates the login form, optionally verifies the PAT against NetBird, and
   * on success binds a one-time authorization code to the credential. Returns a
   * redirect (with the code) or an error to re-render, never throws.
   */
  async completeLogin(form: LoginSubmission): Promise<CompleteLoginResult> {
    const prefill: LoginPrefill = {
      clientId: form.clientId ?? "",
      redirectUri: form.redirectUri ?? "",
      state: form.state ?? "",
      codeChallenge: form.codeChallenge ?? "",
      scope: form.scope ?? "",
      resource: form.resource ?? "",
    };
    const netbirdToken = (form.netbirdToken ?? "").trim();
    const baseUrl = normalizeBaseUrl(form.netbirdApiUrl);
    if (!isHttpUrl(baseUrl)) {
      return {
        kind: "error",
        reason: "The NetBird API URL must be a valid http(s) URL.",
        ...prefill,
      };
    }

    const client = this.store.getClient(prefill.clientId);
    if (!client || !prefill.codeChallenge || !prefill.redirectUri) {
      return {
        kind: "error",
        reason: "This authorization request is invalid or has expired. Start again from Claude.",
        ...prefill,
      };
    }
    if (!client.redirect_uris.includes(prefill.redirectUri)) {
      return {
        kind: "error",
        reason: "The redirect target is not registered for this client.",
        ...prefill,
      };
    }
    if (!netbirdToken) {
      return { kind: "error", reason: "Please paste your NetBird Personal Access Token.", ...prefill };
    }

    if (this.verifyPat) {
      const validity = await this.checkPat(netbirdToken, baseUrl);
      if (validity === "invalid") {
        return {
          kind: "error",
          reason: "That NetBird token was rejected (401/403). Check the token and API URL.",
          ...prefill,
        };
      }
    }

    const code = this.store.createCode({
      clientId: prefill.clientId,
      redirectUri: prefill.redirectUri,
      codeChallenge: prefill.codeChallenge,
      scopes: prefill.scope ? prefill.scope.split(" ").filter(Boolean) : [],
      netbirdToken,
      baseUrl,
    });

    const url = new URL(prefill.redirectUri);
    url.searchParams.set("code", code);
    if (prefill.state) url.searchParams.set("state", prefill.state);
    this.logger.info("oauth authorization granted", { client_id: prefill.clientId });
    return { kind: "redirect", location: url.toString() };
  }

  // --- token protocol (semantics unchanged; only the location moved) ---

  challengeForCode(code: string): string {
    const challenge = this.store.challengeForCode(code);
    if (!challenge) throw new Error("invalid_grant: unknown or expired authorization code");
    return challenge;
  }

  exchangeAuthorizationCode(
    clientId: string,
    authorizationCode: string,
    redirectUri?: string,
  ): OAuthTokens {
    // PKCE was already verified by the SDK token handler via challengeForCode.
    const rec = this.store.takeCode(authorizationCode);
    if (!rec) throw new Error("invalid_grant: unknown or expired authorization code");
    if (rec.clientId !== clientId) throw new Error("invalid_grant: client mismatch");
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new Error("invalid_grant: redirect_uri mismatch");
    }

    const { accessToken, refreshToken } = this.store.issueTokens(
      { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
      clientId,
      rec.scopes,
    );
    return this.tokenResponse(accessToken, refreshToken, rec.scopes);
  }

  exchangeRefreshToken(clientId: string, refreshToken: string, scopes?: string[]): OAuthTokens {
    const rec = this.store.getRefresh(refreshToken);
    if (!rec || rec.clientId !== clientId) {
      throw new Error("invalid_grant: unknown refresh token");
    }
    const grantedScopes = scopes && scopes.length ? scopes : rec.scopes;
    const { accessToken, refreshToken: newRefresh } = this.store.issueTokens(
      { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
      clientId,
      grantedScopes,
    );
    this.store.revoke(refreshToken); // rotate
    return this.tokenResponse(accessToken, newRefresh, grantedScopes);
  }

  verifyAccessToken(token: string): AuthInfo {
    const rec = this.store.getAccess(token);
    if (!rec) throw new Error("invalid_token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      // The bound NetBird credential travels here; resolveBinding unwraps it.
      extra: { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
    };
  }

  /**
   * Resolve a Bearer access token straight to the NetBird credential it's bound
   * to. Wraps verifyAccessToken so the untyped `extra` bag it returns never
   * crosses this seam — callers only ever see AuthContext.
   */
  resolveBinding(bearerToken: string): AuthContext {
    let info: AuthInfo;
    try {
      info = this.verifyAccessToken(bearerToken);
    } catch {
      throw new AuthError("Invalid or expired access token.", "unknown_token");
    }
    const binding = info.extra as unknown as NetBirdBinding | undefined;
    if (!binding?.netbirdToken || !binding.baseUrl) {
      throw new AuthError("Invalid or expired access token.", "unknown_token");
    }
    return { token: binding.netbirdToken, baseUrl: binding.baseUrl };
  }

  revoke(token: string): void {
    this.store.revoke(token);
  }

  private tokenResponse(accessToken: string, refreshToken: string, scopes: string[]): OAuthTokens {
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  /**
   * Delegates PAT verification to a short-lived NetBird client so the auth
   * header convention, timeout, retry, and rate limiting have exactly one
   * implementation — the same one every tool call uses.
   */
  private checkPat(pat: string, baseUrl: string): Promise<TokenVerification> {
    const client = new NetBirdClient({
      auth: { token: pat, baseUrl },
      logger: this.logger,
      rateLimiter: this.verifyLimiter,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      fetchImpl: this.fetchImpl,
    });
    return client.verifyToken();
  }
}

/** The login form's API URL is untrusted input and becomes a fetch target — accept only http(s). */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
