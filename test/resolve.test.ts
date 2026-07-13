import { describe, it, expect } from "vitest";
import { resolveAuth } from "../src/auth/resolve.js";
import { NetBirdOAuthProvider } from "../src/oauth/provider.js";
import { AuthError } from "../src/auth/context.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function newProvider(): NetBirdOAuthProvider {
  return new NetBirdOAuthProvider({ logger: silentLogger, verifyPatOnLogin: false });
}

/** Drive the provider's real public flow to mint a genuine access token. */
async function mintAccessToken(
  provider: NetBirdOAuthProvider,
  binding: { netbirdToken: string; baseUrl: string },
): Promise<string> {
  const client: OAuthClientInformationFull = {
    client_id: "client-123",
    redirect_uris: ["http://localhost:9999/cb"],
  } as OAuthClientInformationFull;
  await provider.clientsStore.registerClient!(client);

  const code = provider.store.createCode({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    codeChallenge: "challenge",
    scopes: ["netbird"],
    netbirdToken: binding.netbirdToken,
    baseUrl: binding.baseUrl,
  });
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    "verifier",
    client.redirect_uris[0],
  );
  return tokens.access_token;
}

describe("resolveAuth", () => {
  it("resolves a valid Bearer token to the bound NetBird credential", async () => {
    const provider = newProvider();
    const accessToken = await mintAccessToken(provider, {
      netbirdToken: "pat-abc",
      baseUrl: "https://self.hosted",
    });

    const auth = await resolveAuth({ authorization: `Bearer ${accessToken}` }, { provider });
    expect(auth).toEqual({ token: "pat-abc", baseUrl: "https://self.hosted" });
  });

  it("rejects a Bearer token unknown to the OAuth store", async () => {
    const provider = newProvider();

    await expect(
      resolveAuth({ authorization: "Bearer nope" }, { provider }),
    ).rejects.toMatchObject({ code: "unknown_token" });
  });

  it("rejects Bearer via the header path when OAuth is disabled (no provider passed)", async () => {
    // Same seam whichever way you describe it: with no provider, a Bearer token
    // falls through to the direct-PAT header resolver, which doesn't recognise it.
    await expect(
      resolveAuth({ authorization: "Bearer some-access-token" }),
    ).rejects.toMatchObject({ code: "oauth_disabled" });
  });

  it("resolves a direct PAT via a custom header", async () => {
    const auth = await resolveAuth(
      { "x-custom-token": "pat" },
      { tokenHeader: "x-custom-token" },
    );
    expect(auth).toEqual({ token: "pat", baseUrl: "https://api.netbird.io" });
  });

  it("resolves a direct PAT via Authorization: Token", async () => {
    const auth = await resolveAuth({ authorization: "Token pat" });
    expect(auth).toEqual({ token: "pat", baseUrl: "https://api.netbird.io" });
  });

  it("rejects when no credentials are present", async () => {
    await expect(resolveAuth({})).rejects.toMatchObject({ code: "missing_credentials" });
  });

  it("honors custom header names end to end", async () => {
    const auth = await resolveAuth(
      { "x-my-token": "pat", "x-my-url": "https://self.hosted/" },
      { tokenHeader: "x-my-token", urlHeader: "x-my-url" },
    );
    expect(auth).toEqual({ token: "pat", baseUrl: "https://self.hosted" });
  });
});
