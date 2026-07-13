import { randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * In-memory OAuth state. Fine for a prototype / single instance. For production,
 * back these with a shared, encrypted store (e.g. Redis) so tokens survive
 * restarts and work across replicas, and so the bound NetBird PAT is at rest
 * encrypted.
 */

/** What a Claude access/refresh token maps to: the tenant's NetBird credential. */
export interface NetBirdBinding {
  netbirdToken: string;
  baseUrl: string;
}

interface CodeRecord extends NetBirdBinding {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}

interface AccessRecord extends NetBirdBinding {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface RefreshRecord extends NetBirdBinding {
  clientId: string;
  scopes: string[];
}

const CODE_TTL_MS = 5 * 60_000; // authorization codes are short-lived
export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export class OAuthStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private readonly refresh = new Map<string, RefreshRecord>();

  // --- clients (dynamic registration) ---
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }
  saveClient(client: OAuthClientInformationFull): void {
    this.clients.set(client.client_id, client);
  }

  // --- authorization codes ---
  createCode(rec: Omit<CodeRecord, "expiresAt">): string {
    const code = token("nbmcp_ac");
    this.codes.set(code, { ...rec, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }
  takeCode(code: string): CodeRecord | undefined {
    const rec = this.codes.get(code);
    this.codes.delete(code); // one-time use
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return rec;
  }
  challengeForCode(code: string): string | undefined {
    return this.codes.get(code)?.codeChallenge;
  }

  // --- access + refresh tokens ---
  issueTokens(binding: NetBirdBinding, clientId: string, scopes: string[]) {
    const accessToken = token("nbmcp_at");
    const refreshToken = token("nbmcp_rt");
    this.access.set(accessToken, {
      ...binding,
      clientId,
      scopes,
      expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
    });
    this.refresh.set(refreshToken, { ...binding, clientId, scopes });
    return { accessToken, refreshToken };
  }

  getAccess(accessToken: string): AccessRecord | undefined {
    const rec = this.access.get(accessToken);
    if (!rec) return undefined;
    if (rec.expiresAt < Date.now()) {
      this.access.delete(accessToken);
      return undefined;
    }
    return rec;
  }

  getRefresh(refreshToken: string): RefreshRecord | undefined {
    return this.refresh.get(refreshToken);
  }

  revoke(token: string): void {
    this.access.delete(token);
    this.refresh.delete(token);
  }
}
