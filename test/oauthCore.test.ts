import { describe, it, expect, vi } from "vitest";
import { OAuthCore, type OAuthCoreOptions } from "../src/oauth/core.js";
import { renderLoginPage, type LoginPageParams } from "../src/oauth/loginPage.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function newCore(opts: Partial<OAuthCoreOptions> = {}): OAuthCore {
  return new OAuthCore({ logger: silentLogger, verifyPatOnLogin: false, ...opts });
}

function registerClient(
  core: OAuthCore,
  overrides: Partial<OAuthClientInformationFull> = {},
): OAuthClientInformationFull {
  const client: OAuthClientInformationFull = {
    client_id: "client-123",
    redirect_uris: ["http://localhost:9999/cb"],
    ...overrides,
  } as OAuthClientInformationFull;
  core.registerClient(client);
  return client;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Strip the decision's `kind` (and `reason`, if present) down to renderable fields. */
function prefillOf(decision: { clientId: string } & Partial<LoginPageParams>): LoginPageParams {
  return {
    clientId: decision.clientId!,
    redirectUri: decision.redirectUri!,
    state: decision.state!,
    codeChallenge: decision.codeChallenge!,
    scope: decision.scope!,
    resource: decision.resource!,
  };
}

describe("OAuthCore.beginAuthorize", () => {
  it("yields a login challenge for a valid authorization request", () => {
    const core = newCore();
    const client = registerClient(core);

    const decision = core.beginAuthorize({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c1",
      state: "s1",
      scopes: ["netbird"],
      resource: "https://example.com/mcp",
    });

    expect(decision).toEqual({
      kind: "challenge",
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      state: "s1",
      codeChallenge: "c1",
      scope: "netbird",
      resource: "https://example.com/mcp",
    });
  });

  it("rejects an unregistered redirect_uri before any rendering", () => {
    const core = newCore();
    const client = registerClient(core);

    const decision = core.beginAuthorize({
      clientId: client.client_id,
      redirectUri: "https://attacker.example/cb",
      codeChallenge: "c1",
    });

    expect(decision.kind).toBe("error");
    expect((decision as { reason: string }).reason).toMatch(/not registered/i);
  });

  it("rejects an unknown client", () => {
    const core = newCore();
    const decision = core.beginAuthorize({
      clientId: "does-not-exist",
      redirectUri: "http://localhost:9999/cb",
      codeChallenge: "c1",
    });

    expect(decision.kind).toBe("error");
    expect((decision as { reason: string }).reason).toMatch(/unknown/i);
  });

  it("rejects a missing PKCE code challenge", () => {
    const core = newCore();
    const client = registerClient(core);
    const decision = core.beginAuthorize({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "",
    });
    expect(decision.kind).toBe("error");
  });
});

describe("OAuthCore.completeLogin", () => {
  it("issues a redirect whose code exchanges for tokens with the right binding", async () => {
    const core = newCore();
    const client = registerClient(core);

    const decision = await core.completeLogin({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "chal",
      state: "s1",
      scope: "netbird",
      netbirdToken: "pat-abc",
      netbirdApiUrl: "https://self.hosted",
    });

    expect(decision.kind).toBe("redirect");
    const location = (decision as { location: string }).location;
    expect(location.startsWith(client.redirect_uris[0])).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code")!;
    expect(code).toBeTruthy();

    expect(core.challengeForCode(code)).toBe("chal");
    const tokens = core.exchangeAuthorizationCode(client.client_id, code, client.redirect_uris[0]);
    expect(tokens.access_token).toBeTruthy();

    const auth = core.resolveBinding(tokens.access_token);
    expect(auth).toEqual({ token: "pat-abc", baseUrl: "https://self.hosted" });
  });

  const errorCases: Array<{
    name: string;
    build: (client: OAuthClientInformationFull) => Parameters<OAuthCore["completeLogin"]>[0];
    reasonPattern: RegExp;
  }> = [
    {
      name: "missing PAT field",
      build: (client) => ({
        clientId: client.client_id,
        redirectUri: client.redirect_uris[0],
        codeChallenge: "c",
        netbirdToken: "",
      }),
      reasonPattern: /paste your NetBird Personal Access Token/i,
    },
    {
      name: "invalid OAuth params (missing code challenge)",
      build: (client) => ({
        clientId: client.client_id,
        redirectUri: client.redirect_uris[0],
        codeChallenge: "",
        netbirdToken: "pat",
      }),
      reasonPattern: /invalid or has expired/i,
    },
    {
      name: "missing OAuth params (unknown client)",
      build: () => ({
        clientId: "unknown-client",
        redirectUri: "http://localhost:9999/cb",
        codeChallenge: "c",
        netbirdToken: "pat",
      }),
      reasonPattern: /invalid or has expired/i,
    },
    {
      name: "unregistered redirect_uri",
      build: (client) => ({
        clientId: client.client_id,
        redirectUri: "https://attacker.example/cb",
        codeChallenge: "c",
        netbirdToken: "pat",
      }),
      reasonPattern: /not registered/i,
    },
  ];

  it.each(errorCases)("re-renders safely on $name", async ({ build, reasonPattern }) => {
    const core = newCore();
    const client = registerClient(core);
    const decision = await core.completeLogin(build(client));

    expect(decision.kind).toBe("error");
    const errorDecision = decision as { reason: string } & LoginPageParams;
    expect(errorDecision.reason).toMatch(reasonPattern);

    // Re-rendering must not throw — the safe-render contract.
    expect(() => renderLoginPage(prefillOf(errorDecision), errorDecision.reason)).not.toThrow();
  });

  it("re-renders safely when the PAT is rejected by NetBird", async () => {
    const rejectingFetch = vi.fn(async () => jsonResponse({}, { status: 401 })) as unknown as typeof fetch;
    const core = newCore({ verifyPatOnLogin: true, fetchImpl: rejectingFetch });
    const client = registerClient(core);

    const decision = await core.completeLogin({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c",
      netbirdToken: "bad-pat",
      netbirdApiUrl: "https://api.netbird.io",
    });

    expect(rejectingFetch).toHaveBeenCalledOnce();
    expect(decision.kind).toBe("error");
    const errorDecision = decision as { reason: string } & LoginPageParams;
    expect(errorDecision.reason).toMatch(/rejected/i);
    expect(() => renderLoginPage(prefillOf(errorDecision), errorDecision.reason)).not.toThrow();
  });
});

describe("login page XSS escaping (via the core's decision output)", () => {
  it("escapes a hostile state value reflected in a login challenge", () => {
    const core = newCore();
    const client = registerClient(core);
    const hostileState = `"><script>alert(1)</script>`;

    const decision = core.beginAuthorize({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c1",
      state: hostileState,
    }) as { kind: "challenge" } & LoginPageParams;

    expect(decision.kind).toBe("challenge");
    const html = renderLoginPage(prefillOf(decision));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`value="${hostileState}"`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("escapes hostile values reflected in a login error re-render", async () => {
    const core = newCore();
    const client = registerClient(core);
    const hostileScope = `netbird" onmouseover="alert(1)`;

    const decision = (await core.completeLogin({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "c1",
      scope: hostileScope,
      netbirdToken: "", // trigger the missing-PAT error path
    })) as { kind: "error"; reason: string } & LoginPageParams;

    expect(decision.kind).toBe("error");
    const html = renderLoginPage(prefillOf(decision), decision.reason);

    expect(html).not.toContain(`value="${hostileScope}"`);
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
  });
});
