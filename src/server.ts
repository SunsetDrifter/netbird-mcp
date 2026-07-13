import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "./auth/context.js";
import type { ServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { NetBirdClient } from "./netbird/client.js";
import { RateLimiter } from "./netbird/rateLimiter.js";
import { registerAllTools } from "./tools/register.js";

export const SERVER_NAME = "netbird";
export const SERVER_VERSION = "0.1.0";

export interface BuildServerDeps {
  auth: AuthContext;
  config: ServerConfig;
  logger: Logger;
  /** Optional shared rate limiter (stdio reuses one; HTTP passes a shared instance). */
  rateLimiter?: RateLimiter;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a fully-wired MCP server for a single AuthContext. Transport is chosen by
 * the caller (bin/stdio or bin/http) — this function knows nothing about it, which
 * is what lets the exact same tool set serve local and cloud.
 */
export function buildServer(deps: BuildServerDeps): McpServer {
  const { auth, config, logger } = deps;

  const client = new NetBirdClient({
    auth,
    logger,
    rateLimiter: deps.rateLimiter ?? new RateLimiter(config.maxRequestsPerMinute),
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAllTools(server, { client, config, logger });
  return server;
}
