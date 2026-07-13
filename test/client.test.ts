import { describe, it, expect, vi } from "vitest";
import { NetBirdClient, NetBirdApiError } from "../src/netbird/client.js";
import { RateLimiter } from "../src/netbird/rateLimiter.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient(fetchImpl: typeof fetch, maxRetries = 4) {
  return new NetBirdClient({
    auth: { token: "test-pat", baseUrl: "https://api.netbird.io" },
    logger: silentLogger,
    rateLimiter: new RateLimiter(1000),
    timeoutMs: 5000,
    fetchImpl,
    maxRetries,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("NetBirdClient", () => {
  it("sends the Token auth header and parses JSON", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Token test-pat");
      return jsonResponse([{ id: "p1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const peers = await client.get("/api/peers");
    expect(peers).toEqual([{ id: "p1" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("appends query params, skipping undefined", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("https://api.netbird.io/api/peers?name=laptop");
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.get("/api/peers", { name: "laptop", ip: undefined });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.get("/api/peers");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("throws NetBirdApiError on 4xx (non-429)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "not found" }, { status: 404 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(client.get("/api/peers/nope")).rejects.toBeInstanceOf(NetBirdApiError);
  });

  it("serializes JSON bodies on writes", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ name: "eng" });
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return jsonResponse({ id: "g1", name: "eng" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const group = await client.post("/api/groups", { name: "eng" });
    expect(group).toEqual({ id: "g1", name: "eng" });
  });
});

describe("NetBirdClient#verifyToken", () => {
  it("hits /api/users with the Token auth header and returns ok on success", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://api.netbird.io/api/users");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Token test-pat");
      return jsonResponse([{ id: "u1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("ok");
  });

  it("returns invalid on 401", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "unauthorized" }, { status: 401 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("invalid");
  });

  it("returns invalid on 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "forbidden" }, { status: 403 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("invalid");
  });

  it("retries on 429 then returns ok", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse([{ id: "u1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns unknown on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, 0);
    expect(await client.verifyToken()).toBe("unknown");
  });

  it("returns unknown on 500", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "boom" }, { status: 500 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, 0);
    expect(await client.verifyToken()).toBe("unknown");
  });
});
