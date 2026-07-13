#!/usr/bin/env node
import { createHash } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authFromRequest } from "../auth/fromRequest.js";
import { AuthContext, AuthError } from "../auth/context.js";
import { loadServerConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { RateLimiter } from "../netbird/rateLimiter.js";
import { buildServer } from "../server.js";
import { NetBirdOAuthProvider } from "../oauth/provider.js";

/**
 * CLOUD entrypoint. Speaks MCP over Streamable HTTP so the server can be hosted
 * and added to Claude as a remote/custom connector.
 *
 * Two ways to authenticate, both resolving to a per-request NetBird AuthContext:
 *   1. OAuth 2.1 (what Claude uses): the client registers dynamically, runs an
 *      authorization-code + PKCE flow, and sends `Authorization: Bearer <token>`.
 *   2. Direct PAT (handy for testing / simple deploys): `x-netbird-token` header
 *      or `Authorization: Token <pat>`.
 *
 * Stateless: each request gets a fresh server instance, so one deployment safely
 * serves many tenants and scales horizontally.
 */
const config = loadServerConfig();
const logger = createLogger(config.logLevel);
const { port, tokenHeader, urlHeader, oauthEnabled, publicBaseUrl, verifyPatOnLogin } =
  config.http;

const provider = new NetBirdOAuthProvider({ logger, verifyPatOnLogin });

// One rate limiter per tenant (keyed by a hash of the NetBird token, never the token
// itself), so NetBird's per-account limit is respected without cross-tenant interference.
const limiters = new Map<string, RateLimiter>();
function limiterFor(token: string): RateLimiter {
  const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(config.maxRequestsPerMinute);
    limiters.set(key, limiter);
  }
  return limiter;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false })); // OAuth login form posts

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", oauth: oauthEnabled });
});

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${publicBaseUrl}/mcp`));

if (oauthEnabled) {
  // Standard MCP authorization-server endpoints: metadata discovery, dynamic client
  // registration, /authorize, /token, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicBaseUrl),
      resourceServerUrl: new URL(`${publicBaseUrl}/mcp`),
      scopesSupported: ["netbird"],
      resourceName: "NetBird",
    }),
  );
  // Our interactive login step (the page /authorize renders posts here).
  app.post("/oauth/netbird-login", provider.handleLogin);
}

/** Resolve a request to a NetBird AuthContext, or throw AuthError. */
async function resolveAuth(req: express.Request): Promise<AuthContext> {
  const authz = req.headers.authorization;
  if (oauthEnabled && authz && /^Bearer\s+/i.test(authz)) {
    const token = authz.replace(/^Bearer\s+/i, "").trim();
    try {
      const info = await provider.verifyAccessToken(token);
      const extra = info.extra as { netbirdToken: string; baseUrl: string };
      return { token: extra.netbirdToken, baseUrl: extra.baseUrl };
    } catch {
      throw new AuthError("Invalid or expired access token.");
    }
  }
  // Direct-PAT fallback (x-netbird-token or Authorization: Token).
  return authFromRequest(req.headers, { tokenHeader, urlHeader });
}

app.post("/mcp", async (req, res) => {
  let auth: AuthContext;
  try {
    auth = await resolveAuth(req);
  } catch (err) {
    if (err instanceof AuthError) {
      // Point unauthenticated clients at the resource metadata so Claude can
      // discover the OAuth endpoints and start the flow.
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: err.message }, id: null });
      return;
    }
    throw err;
  }

  // Stateless: fresh transport + server per request, disposed when the response closes.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer({ auth, config, logger, rateLimiter: limiterFor(auth.token) });

  res.on("close", () => {
    transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("error handling mcp request", { message: (err as Error).message });
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Streamable HTTP GET/DELETE are for stateful sessions; this server is stateless.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless; use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(port, () => {
  logger.info("netbird mcp server ready (http)", {
    port,
    endpoint: "/mcp",
    publicBaseUrl,
    oauthEnabled,
    destructiveEnabled: config.enableDestructive,
  });
});
