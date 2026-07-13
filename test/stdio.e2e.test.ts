import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * End-to-end coverage of the LOCAL entrypoint: spawn the real stdio binary
 * with env credentials and speak MCP over its stdin/stdout — the same
 * interface Claude Desktop uses. A fake NetBird API on localhost records the
 * Authorization header so the test can observe the credential on the wire.
 */

const TSX = resolve("node_modules/.bin/tsx");
const ENTRY = resolve("src/bin/stdio.ts");

interface SeenRequest {
  method: string;
  url: string;
  auth: string | undefined;
}

const INIT_MESSAGES = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"stdio-e2e","version":"0.0.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
];

function spawnStdioServer(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(TSX, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Send messages and resolve with the first JSON-RPC response matching id. */
function responseWithId(
  child: ChildProcess,
  messages: string[],
  id: number,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`no response with id ${id}; stdout so far: ${buffer}`));
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === id) {
            clearTimeout(timer);
            resolvePromise(parsed);
            return;
          }
        } catch {
          // partial line still buffering
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.stdin!.write(messages.join("\n") + "\n");
  });
}

describe("stdio entrypoint (spawned binary)", () => {
  let api: Server;
  let apiUrl: string;
  const seen: SeenRequest[] = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "peer-1", name: "e2e-peer", ip: "100.64.0.9" }]));
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => api.close(r));
  });

  it(
    "authenticates env credentials as Authorization: Token on the wire and answers over stdio",
    async () => {
      const child = spawnStdioServer({
        ...process.env,
        NETBIRD_API_TOKEN: "test-pat-e2e",
        NETBIRD_API_URL: `${apiUrl}/`, // trailing slash: must be normalized away
        LOG_LEVEL: "error",
      });
      try {
        const response = await responseWithId(
          child,
          [
            ...INIT_MESSAGES,
            '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_peers","arguments":{}}}',
          ],
          2,
        );

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(result.content[0].text)).toEqual([
          { id: "peer-1", name: "e2e-peer", ip: "100.64.0.9" },
        ]);

        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
          method: "GET",
          url: "/api/peers",
          auth: "Token test-pat-e2e",
        });
      } finally {
        child.kill();
      }
    },
    20_000,
  );

  it(
    "exits 1 with an actionable message when NETBIRD_API_TOKEN is missing",
    async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: "error" };
      delete env.NETBIRD_API_TOKEN;
      const child = spawnStdioServer(env);

      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [exitCode] = (await once(child, "exit")) as [number | null];

      expect(exitCode).toBe(1);
      expect(stderr).toContain("NETBIRD_API_TOKEN is not set");
    },
    20_000,
  );
});
