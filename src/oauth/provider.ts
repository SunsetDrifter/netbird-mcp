import type { Request, Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { normalizeBaseUrl } from "../config.js";
import type { Logger } from "../logger.js";
import { NetBirdClient } from "../netbird/client.js";
import { RateLimiter } from "../netbird/rateLimiter.js";
import { ACCESS_TTL_SECONDS, OAuthStore } from "./store.js";
import { renderLoginPage } from "./loginPage.js";

// Defaults for the short-lived client built solely to verify a PAT at login
// time (mirrors the ServerConfig defaults in config.ts).
const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFY_MAX_REQUESTS_PER_MINUTE = 110;

export interface ProviderOptions {
  logger: Logger;
  /** Verify a NetBird PAT during login by making a cheap read call. */
  verifyPatOnLogin?: boolean;
  fetchImpl?: typeof fetch;
  /** Timeout for the login-time PAT verification call, in ms. */
  verifyTimeoutMs?: number;
  /** Client-side rate-limit cap applied to the login-time verification call. */
  verifyMaxRequestsPerMinute?: number;
}

/**
 * OAuth 2.1 authorization server for the NetBird connector. Claude registers
 * dynamically (RFC 7591) and drives an authorization-code + PKCE flow. During
 * `authorize` we present a login page where the user pastes a NetBird PAT; the
 * issued Claude token is then bound to that PAT server-side. Tool code never sees
 * OAuth — it only ever receives a resolved { token, baseUrl } AuthContext.
 *
 * v2 upgrade: swap the login step for an upstream IdP redirect (real SSO) and
 * bind the resulting NetBird OAuth token instead of a PAT — nothing else changes.
 */
export class NetBirdOAuthProvider implements OAuthServerProvider {
  readonly store = new OAuthStore();
  private readonly logger: Logger;
  private readonly verifyPat: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly verifyTimeoutMs: number;
  private readonly verifyMaxRequestsPerMinute: number;

  constructor(opts: ProviderOptions) {
    this.logger = opts.logger;
    this.verifyPat = opts.verifyPatOnLogin ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.verifyMaxRequestsPerMinute =
      opts.verifyMaxRequestsPerMinute ?? DEFAULT_VERIFY_MAX_REQUESTS_PER_MINUTE;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        this.store.saveClient(full);
        this.logger.info("oauth client registered", { client_id: full.client_id });
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Render the login page; the form POSTs to /oauth/netbird-login, carrying the
    // OAuth params forward so we can mint the code and redirect back to Claude.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderLoginPage({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state ?? "",
        codeChallenge: params.codeChallenge,
        scope: (params.scopes ?? []).join(" "),
        resource: params.resource?.toString() ?? "",
      }),
    );
  }

  /**
   * Handles the login form submission (mounted as POST /oauth/netbird-login).
   * Not part of the OAuthServerProvider interface — it's our interactive step.
   */
  handleLogin = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, string>;
    const clientId = body.client_id;
    const redirectUri = body.redirect_uri;
    const state = body.state ?? "";
    const codeChallenge = body.code_challenge;
    const scope = body.scope ?? "";
    const netbirdToken = (body.netbird_token ?? "").trim();
    const baseUrl = normalizeBaseUrl(body.netbird_api_url);

    const rerender = (error: string) =>
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").send(
        renderLoginPage(
          { clientId, redirectUri, state, codeChallenge, scope, resource: body.resource ?? "" },
          error,
        ),
      );

    const client = this.store.getClient(clientId);
    if (!client || !codeChallenge || !redirectUri) {
      rerender("This authorization request is invalid or has expired. Start again from Claude.");
      return;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      rerender("The redirect target is not registered for this client.");
      return;
    }
    if (!netbirdToken) {
      rerender("Please paste your NetBird Personal Access Token.");
      return;
    }

    if (this.verifyPat) {
      const validity = await this.checkPat(netbirdToken, baseUrl);
      if (validity === "invalid") {
        rerender("That NetBird token was rejected (401/403). Check the token and API URL.");
        return;
      }
    }

    const code = this.store.createCode({
      clientId,
      redirectUri,
      codeChallenge,
      scopes: scope ? scope.split(" ").filter(Boolean) : [],
      netbirdToken,
      baseUrl,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    this.logger.info("oauth authorization granted", { client_id: clientId });
    res.redirect(302, url.toString());
  };

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const challenge = this.store.challengeForCode(authorizationCode);
    if (!challenge) throw new Error("invalid_grant: unknown or expired authorization code");
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // PKCE was already verified by the SDK token handler via challengeForAuthorizationCode.
    const rec = this.store.takeCode(authorizationCode);
    if (!rec) throw new Error("invalid_grant: unknown or expired authorization code");
    if (rec.clientId !== client.client_id) throw new Error("invalid_grant: client mismatch");
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new Error("invalid_grant: redirect_uri mismatch");
    }

    const { accessToken, refreshToken } = this.store.issueTokens(
      { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
      client.client_id,
      rec.scopes,
    );
    return this.tokenResponse(accessToken, refreshToken, rec.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const rec = this.store.getRefresh(refreshToken);
    if (!rec || rec.clientId !== client.client_id) {
      throw new Error("invalid_grant: unknown refresh token");
    }
    const grantedScopes = scopes && scopes.length ? scopes : rec.scopes;
    const { accessToken, refreshToken: newRefresh } = this.store.issueTokens(
      { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
      client.client_id,
      grantedScopes,
    );
    this.store.revoke(refreshToken); // rotate
    return this.tokenResponse(accessToken, newRefresh, grantedScopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.store.getAccess(token);
    if (!rec) throw new Error("invalid_token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      // The bound NetBird credential travels here; the /mcp handler reads it.
      extra: { netbirdToken: rec.netbirdToken, baseUrl: rec.baseUrl },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: { token: string },
  ): Promise<void> {
    this.store.revoke(request.token);
  }

  private tokenResponse(
    accessToken: string,
    refreshToken: string,
    scopes: string[],
  ): OAuthTokens {
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
  private checkPat(pat: string, baseUrl: string): Promise<"ok" | "invalid" | "unknown"> {
    const client = new NetBirdClient({
      auth: { token: pat, baseUrl },
      logger: this.logger,
      rateLimiter: new RateLimiter(this.verifyMaxRequestsPerMinute),
      timeoutMs: this.verifyTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
    return client.verifyToken();
  }
}
