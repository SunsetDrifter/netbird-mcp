import { describe, it, expect } from "vitest";
import { authFromEnv } from "../src/auth/fromEnv.js";
import { authFromRequest } from "../src/auth/fromRequest.js";
import { AuthError } from "../src/auth/context.js";

describe("authFromEnv (local)", () => {
  it("resolves token and default base URL", () => {
    const auth = authFromEnv({ NETBIRD_API_TOKEN: "pat" } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ token: "pat", baseUrl: "https://api.netbird.io" });
  });

  it("honors a custom base URL and strips trailing slash", () => {
    const auth = authFromEnv({
      NETBIRD_API_TOKEN: "pat",
      NETBIRD_API_URL: "https://nb.example.com/",
    } as NodeJS.ProcessEnv);
    expect(auth.baseUrl).toBe("https://nb.example.com");
  });

  it("throws AuthError when token missing", () => {
    expect(() => authFromEnv({} as NodeJS.ProcessEnv)).toThrow(AuthError);
  });
});

describe("authFromRequest (cloud)", () => {
  // Header names are required parameters now — config.ts is their only default source.
  const headers = { tokenHeader: "x-netbird-token", urlHeader: "x-netbird-api-url" };

  it("reads the dedicated token header", () => {
    const auth = authFromRequest({ "x-netbird-token": "pat" }, headers);
    expect(auth.token).toBe("pat");
    expect(auth.baseUrl).toBe("https://api.netbird.io");
  });

  it("accepts Authorization: Token but NOT Bearer (Bearer is reserved for OAuth)", () => {
    expect(authFromRequest({ authorization: "Token pat" }, headers).token).toBe("pat");
    expect(() =>
      authFromRequest({ authorization: "Bearer oauth-access-token" }, headers),
    ).toThrow(AuthError);
  });

  it("reads a per-tenant base URL header", () => {
    const auth = authFromRequest(
      {
        "x-netbird-token": "pat",
        "x-netbird-api-url": "https://self.hosted/",
      },
      headers,
    );
    expect(auth.baseUrl).toBe("https://self.hosted");
  });

  it("honors custom header names supplied by the caller", () => {
    const auth = authFromRequest(
      { "x-custom-token": "pat", "x-custom-url": "https://self.hosted/" },
      { tokenHeader: "x-custom-token", urlHeader: "x-custom-url" },
    );
    expect(auth).toEqual({ token: "pat", baseUrl: "https://self.hosted" });
  });

  it("throws AuthError when no credential present", () => {
    expect(() => authFromRequest({}, headers)).toThrow(AuthError);
  });

  it("requires the header-name options (no internal fallback)", () => {
    // @ts-expect-error tokenHeader and urlHeader are required — there is no default here.
    expect(() => authFromRequest({ "x-netbird-token": "pat" })).toThrow();
  });
});
