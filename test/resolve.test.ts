import { describe, it, expect, vi } from "vitest";
import { resolveAuth } from "../src/auth/resolve.js";
import { NetBirdOAuthProvider } from "../src/oauth/provider.js";
import { AuthError } from "../src/auth/context.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function newProvider(): NetBirdOAuthProvider {
  return new NetBirdOAuthProvider({ logger: silentLogger, verifyPatOnLogin: false });
}

/**
 * Drive the provider's real public flow to mint a genuine access token. The
 * store is private to the OAuth core now, so the code is minted through the
 * login form handler (the same entry point Claude's flow posts to) instead of
 * writing to storage directly.
 */
async function mintAccessToken(
  provider: NetBirdOAuthProvider,
  binding: { netbirdToken: string; baseUrl: string },
): Promise<string> {
  const client: OAuthClientInformationFull = {
    client_id: "client-123",
    redirect_uris: ["http://localhost:9999/cb"],
  } as OAuthClientInformationFull;
  await provider.clientsStore.registerClient!(client);

  const req = {
    body: {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: "challenge",
      scope: "netbird",
      netbird_token: binding.netbirdToken,
      netbird_api_url: binding.baseUrl,
    },
  } as unknown as import("express").Request;
  let redirected: string | undefined;
  const res = {
    status() {
      return this;
    },
    setHeader() {
      return this;
    },
    send() {},
    redirect(_code: number, url: string) {
      redirected = url;
    },
  } as unknown as import("express").Response;

  await provider.handleLogin(req, res);
  const code = new URL(redirected!).searchParams.get("code")!;

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

describe("resolveAuth — scheme and expiry edges", () => {
  async function authErrorCode(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      return (err as AuthError).code;
    }
    throw new Error("expected AuthError, but the promise resolved");
  }

  it("tags an unrecognized Authorization scheme as wrong_scheme", async () => {
    const code = await authErrorCode(resolveAuth({ authorization: "Basic dXNlcjpwdw==" }));
    expect(code).toBe("wrong_scheme");
  });

  it("rejects an expired Bearer token as unknown_token", async () => {
    vi.useFakeTimers();
    try {
      const provider = newProvider();
      const token = await mintAccessToken(provider, {
        netbirdToken: "pat-x",
        baseUrl: "https://api.example.com",
      });
      vi.advanceTimersByTime(61 * 60 * 1000); // past the 1h access-token TTL
      const code = await authErrorCode(
        resolveAuth({ authorization: `Bearer ${token}` }, { provider }),
      );
      expect(code).toBe("unknown_token");
    } finally {
      vi.useRealTimers();
    }
  });
});
