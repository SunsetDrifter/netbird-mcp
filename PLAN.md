# NetBird MCP Server — Implementation Plan (v1)

Derived from the Notion proposal **"Claude Connector for NetBird — v1 Proposal"** (Kim, 2026-07-11).
Primary added requirement here: **one codebase that runs both locally (stdio) and in the cloud (remote HTTP connector).**

---

## 0. TL;DR

- Build one MCP server in **TypeScript** with the official `@modelcontextprotocol/sdk`.
- Keep **tool logic + NetBird API client transport-agnostic**; add **two thin entrypoints**:
  - `bin/stdio` → local use (Claude Desktop, Claude Code, MCP Inspector).
  - `bin/http` → cloud use (Streamable HTTP, deployable as a Claude custom/remote connector).
- Abstract auth behind an **`AuthContext`** so v1 uses a **NetBird PAT** in both modes (env locally, per-request header in cloud), and v2 can swap in **OAuth2** without touching tool code.
- Ship **read-heavy v1**; gate the few writes and all deletes behind explicit-confirmation + exact-resource-name rules.

---

## 1. Why this shape (local + cloud from one build)

The MCP spec defines multiple transports over the *same* server object:

| Mode | Transport | Who runs it | Auth in v1 |
|------|-----------|-------------|------------|
| **Local** | `StdioServerTransport` | User's machine as a subprocess of Claude Desktop / Claude Code | PAT from env var |
| **Cloud** | `StreamableHTTPServerTransport` (HTTP, optional SSE streaming) | A hosted service; added in Claude as a remote/custom connector | PAT from per-request header → OAuth2 in v2 |

Because both transports wrap the *identical* `McpServer` instance and tool set, the only things that differ are (a) how the process starts and (b) where the NetBird credential comes from. We isolate exactly those two things and share everything else.

---

## 2. Tech choices

- **Language / runtime:** TypeScript on Node 24 (already installed). Matches how most official Claude connectors are built and gives the best dual-transport support.
- **MCP SDK:** `@modelcontextprotocol/sdk`.
- **Validation:** `zod` for every tool's input schema (also generates the JSON schema Claude sees).
- **HTTP layer (cloud only):** minimal `express` (or built-in `node:http`) exposing a single `/mcp` route + `/healthz`.
- **HTTP client:** built-in `fetch` — no heavy dependency.
- **Tests:** `vitest` + a mocked NetBird API; `@modelcontextprotocol/inspector` for manual local testing.
- **Packaging:** npm package (`npx`-runnable) for local; Dockerfile for cloud.

---

## 3. Project structure

```
src/
  server.ts            # buildServer(deps) -> McpServer; registers all tools. Transport-agnostic.
  config.ts            # env parsing, defaults (NETBIRD_API_URL, timeouts, log level)
  auth/
    context.ts         # AuthContext type: { token, baseUrl } resolved per session
    fromEnv.ts         # local: read PAT + base URL from env
    fromRequest.ts     # cloud: extract PAT from request header (v2: OAuth2 exchange)
  netbird/
    client.ts          # REST client: Authorization: Token <PAT>, pagination, 429 backoff
    types.ts           # typed responses (Peer, Group, Policy, Network, Event, ...)
  tools/
    peers.ts           # list_peers, get_peer, list_accessible_peers, update_peer, (delete_peer)
    setupKeys.ts       # list_setup_keys, create_setup_key, update_setup_key
    groups.ts          # list_groups, create_group, update_group, (delete_group)
    policies.ts        # list_policies, get_policy, create_policy, update_policy, (delete_policy)
    networks.ts        # list_networks, get_network
    dns.ts             # list_nameserver_groups, get_dns_settings
    visibility.ts      # list_posture_checks, list_events
    register.ts        # wires all tool modules into the server
  bin/
    stdio.ts           # LOCAL entrypoint  -> StdioServerTransport
    http.ts            # CLOUD entrypoint  -> StreamableHTTPServerTransport + express
test/
Dockerfile
package.json           # "bin" for stdio; "start:http" script for cloud
README.md
```

**Rule:** `tools/*` and `netbird/client.ts` never import a transport or read `process.env` directly. They receive a resolved `AuthContext` / client. That is what keeps local and cloud identical below the entrypoint.

---

## 4. v1 tool list (from proposal §4)

Read tools are enabled by default. Writes are enabled but gated. Deletes are behind a `NETBIRD_ENABLE_DESTRUCTIVE` flag (off by default in v1).

**Peers:** `list_peers` (R), `get_peer` (R), `list_accessible_peers` (R), `update_peer` (W, confirm), `delete_peer` (W-destructive, flag-gated / candidate to drop from v1).
**Setup keys:** `list_setup_keys` (R), `create_setup_key` (W, additive), `update_setup_key` (W, mainly revoke).
**Groups & policies:** `list_groups` (R), `create_group`/`update_group` (W), `list_policies` (R), `get_policy` (R), `create_policy`/`update_policy` (W, draft-and-confirm), `delete_policy`/`delete_group` (W-destructive, flag-gated).
**Networks / DNS:** `list_networks` (R), `get_network` (R), `list_nameserver_groups` (R), `get_dns_settings` (R). DNS writes deferred to v2.
**Visibility:** `list_posture_checks` (R), `list_events` (R).

**Out of scope for v1 (per proposal):** Users/Accounts admin, Tokens, MSP, Invoice/Usage, cloud-only IDP/EDR integration configs.

---

## 5. Auth approach (v1 = PAT, both modes)

`AuthContext = { token: string; baseUrl: string }`.

- **Local (`bin/stdio.ts`):** `fromEnv()` reads `NETBIRD_API_TOKEN` and `NETBIRD_API_URL` (default `https://api.netbird.io`). Single tenant. Fail fast with a clear message if the token is missing.
- **Cloud (`bin/http.ts`):** `fromRequest()` reads the PAT from an inbound header on each request (Claude custom-connector "API key" / header config), plus an optional per-tenant base URL. **Token is used only for the life of the request/session — never persisted server-side.** This keeps the hosted server multi-tenant and stateless.
- Every NetBird call sends `Authorization: Token <PAT>`. No refresh logic in v1.
- **Self-hosted NetBird** is supported for free because `baseUrl` is configurable in both modes.

**v2 upgrade path:** replace `fromRequest()` with an OAuth2 flow (user's IdP authorizes the connector); `server.ts` and all `tools/*` are unchanged.

---

## 6. Safety & reliability (proposal §5.2)

- **Rate limits:** client-side token bucket tuned under NetBird cloud's 120 req/min (burst 1200); exponential backoff honoring `Retry-After` on `429`. Callers/users never need to know the limit.
- **Destructive gating:** `delete_*` tools (a) are off unless `NETBIRD_ENABLE_DESTRUCTIVE=true`, (b) carry explicit-confirmation language in their descriptions, and (c) require the exact resource name/id — never a filtered batch.
- **Write confirmation:** `update_peer`, `create/update_policy`, `create/update_group` follow a draft-and-confirm pattern — return the intended change for the model to echo before applying.
- **Pagination:** transparent — tools return complete lists (bounded) rather than leaking cursor mechanics.
- **Logging:** structured logs (stderr for stdio so as not to corrupt the protocol stream; stdout for cloud). No token values ever logged.

---

## 7. Running it

**Local — Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "netbird": {
      "command": "npx",
      "args": ["-y", "@netbird/mcp"],
      "env": {
        "NETBIRD_API_TOKEN": "nb_pat_xxx",
        "NETBIRD_API_URL": "https://api.netbird.io"
      }
    }
  }
}
```

**Local — Claude Code:**
```
claude mcp add netbird -e NETBIRD_API_TOKEN=nb_pat_xxx -- npx -y @netbird/mcp
```

**Local — dev/debug:** `npm run inspect` (MCP Inspector against `bin/stdio`).

**Cloud:** `docker build` → deploy behind TLS → server listens on `/mcp`. Register in Claude as a **remote/custom connector** pointing at `https://<host>/mcp`, with the NetBird PAT supplied in the connector's credential field. Stateless containers scale horizontally (no sticky sessions needed since auth rides each request).

---

## 8. Build phases

1. **Scaffold + core (read path).** Repo, config, `AuthContext`, NetBird client (auth + pagination + 429 backoff), `server.ts`, `bin/stdio.ts`. Ship read tools first: `list_peers`, `get_peer`, `list_policies`, `list_groups`, `list_events`. Verify locally with Inspector + Claude Desktop.
2. **Finish reads + low-risk writes.** Remaining reads (`list_accessible_peers`, networks, DNS, setup keys, posture). Additive/low-risk writes: `create_setup_key`, `update_setup_key`, `create/update_group`, `update_peer`, `create/update_policy` (draft-and-confirm).
3. **Cloud transport.** `bin/http.ts` with Streamable HTTP + `fromRequest()` auth, `/healthz`, Dockerfile. Deploy; register as a custom connector; confirm the *same* tools work remotely.
4. **Hardening + docs.** Rate-limit tuning, destructive-tool gating, structured logging, README, and the Claude Desktop/Code/remote setup snippets. Align final tool list + auth with Nima before wider rollout.
5. **v2 (post-validation).** OAuth2, DNS writes, posture-check authoring, full CRUD, and the deferred cloud-only resources.

---

## 9. Open questions to confirm before build

- **`delete_peer` in v1?** Proposal flags it as a candidate to exclude — recommend shipping deletes flag-gated and **off by default**.
- **Cloud PAT delivery mechanism** — confirm the exact header/credential field Claude's custom-connector config exposes so `fromRequest()` matches it.
- **Publishing target** — npm scope (`@netbird/mcp`) and container registry for the hosted build.
- **Sign-off** — align this tool list + auth approach with Nima (per proposal §6) before scaffolding.
