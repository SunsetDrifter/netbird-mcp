import { describe, it, expect } from "vitest";
import { NetBirdOAuthProvider } from "../src/oauth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function newProvider() {
  return new NetBirdOAuthProvider({ logger: silentLogger, verifyPatOnLogin: false });
}

async function registerClient(p: NetBirdOAuthProvider): Promise<OAuthClientInformationFull> {
  const client: OAuthClientInformationFull = {
    client_id: "client-123",
    redirect_uris: ["http://localhost:9999/cb"],
  } as OAuthClientInformationFull;
  await p.clientsStore.registerClient!(client);
  return client;
}

describe("NetBirdOAuthProvider", () => {
  it("registers and retrieves clients", async () => {
    const p = newProvider();
    const client = await registerClient(p);
    expect(await p.clientsStore.getClient!("client-123")).toBe(client);
  });

  it("exchanges an authorization code for tokens bound to the NetBird PAT", async () => {
    const p = newProvider();
    const client = await registerClient(p);

    const code = p.store.createCode({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge",
      scopes: ["netbird"],
      netbirdToken: "pat-abc",
      baseUrl: "https://api.netbird.io",
    });

    // SDK verifies PKCE separately; the challenge must be retrievable pre-exchange.
    expect(await p.challengeForAuthorizationCode(client, code)).toBe("challenge");

    const tokens = await p.exchangeAuthorizationCode(client, code, "verifier", client.redirect_uris[0]);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe("client-123");
    expect(info.extra).toEqual({ netbirdToken: "pat-abc", baseUrl: "https://api.netbird.io" });
  });

  it("rejects a reused (one-time) authorization code", async () => {
    const p = newProvider();
    const client = await registerClient(p);
    const code = p.store.createCode({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c",
      scopes: [],
      netbirdToken: "pat",
      baseUrl: "https://api.netbird.io",
    });
    await p.exchangeAuthorizationCode(client, code, "v", client.redirect_uris[0]);
    await expect(
      p.exchangeAuthorizationCode(client, code, "v", client.redirect_uris[0]),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("refresh_token grant rotates and preserves the NetBird binding", async () => {
    const p = newProvider();
    const client = await registerClient(p);
    const code = p.store.createCode({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c",
      scopes: ["netbird"],
      netbirdToken: "pat-xyz",
      baseUrl: "https://self.hosted",
    });
    const first = await p.exchangeAuthorizationCode(client, code, "v", client.redirect_uris[0]);
    const refreshed = await p.exchangeRefreshToken(client, first.refresh_token!);

    expect(refreshed.access_token).not.toBe(first.access_token);
    const info = await p.verifyAccessToken(refreshed.access_token);
    expect(info.extra).toEqual({ netbirdToken: "pat-xyz", baseUrl: "https://self.hosted" });

    // Old refresh token is rotated out.
    await expect(p.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it("rejects unknown access tokens", async () => {
    const p = newProvider();
    await expect(p.verifyAccessToken("nope")).rejects.toThrow(/invalid_token/);
  });
});
