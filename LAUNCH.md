# NetBird MCP — Path to Production ("publish for Cloud users")

Goal: let **any NetBird Cloud customer** add the NetBird connector from their own Claude account
and manage their network in natural language — ultimately as an **official Claude connector**.

The prototype (see [`PLAN.md`](PLAN.md), [`README.md`](README.md)) already covers the hard
functional parts: the tool set, the dual stdio/HTTP transports, and a working OAuth 2.1 flow.
Getting to a public, multi-tenant service is now mostly **infra, security, and process** — not
new features. This doc is the checklist for that.

---

## 0. The one big decision up front: how Cloud users authenticate

Today the OAuth flow asks the user to **paste a NetBird PAT** on the login page. That works, but
for a productized offering to all Cloud customers it's friction + a credential-handling burden.
Two target states:

| | **A. PAT-in-OAuth (built today)** | **B. IdP-federated login (the real product)** |
|---|---|---|
| User experience | Click Connect → paste a PAT once | Click Connect → log in with their NetBird account → done |
| NetBird API auth | Static PAT bound to the OAuth token | Short-lived OAuth2 bearer from the user's IdP |
| Eng cost | ~done | Register the connector as an app in NetBird's auth/IdP; proxy the upstream flow |
| Dependency | none | **NetBird platform/auth team** must provision an OAuth app + scopes |

**Recommendation:** ship **A** to a private beta to validate demand and the tool set, and run **B**
in parallel as the GA experience. B is what "official connector" customers will expect. The MCP
SDK's `ProxyOAuthServerProvider` is designed for exactly this upstream-proxy pattern, so B slots
into the existing `authorize` seam without touching any tool code.

This choice drives Phase 2, so decide it early.

---

## 1. Workstreams (what "production-ready" requires)

### 1.1 State & data layer — **blocker for multi-tenant**
- Replace the in-memory OAuth store with a **persistent, shared store** (Redis or Postgres) so
  tokens survive restarts and work across replicas.
- **Encrypt bound credentials at rest** (PAT or refresh token) with a KMS-managed key; never store
  plaintext. Rotate the encryption key on a schedule.
- TTLs + cleanup for codes/tokens; refresh-token rotation (already modeled) enforced in the store.

### 1.2 Infrastructure & deploy
- Real host: container platform (ECS/Fly/Cloud Run/K8s — match NetBird's existing stack), behind
  TLS on a dedicated domain (e.g. `mcp.netbird.io`).
- Horizontal scaling (server is already stateless once the store is external); `/healthz` +
  readiness probes; graceful shutdown.
- **CI/CD**: GitHub Actions — lint, typecheck, `npm test`, build, Docker image publish to a
  registry, deploy. Tag-based releases, semver, changelog, SBOM.
- Resolve the `npm audit` findings from the prototype install before any publish.

### 1.3 Security & compliance
- **Threat model** the OAuth AS + `/mcp` (token theft, replay, redirect_uri abuse, SSRF via
  self-hosted base URL, tenant isolation). Much is handled by the SDK (PKCE, redirect validation,
  auth-endpoint rate limiting) — document what's covered vs. added.
- Secrets via a manager (not env files) in production; KMS for the at-rest key.
- **Log scrubbing** — never log PAT/OAuth tokens (already the rule; add a lint/test guard).
- CSRF protection on the login form; security headers (HSTS, CSP) on the AS pages.
- Independent **security review / pen test** before public GA.
- **GDPR / DPA**: NetBird is EU-based — data-processing agreement, data-residency story, privacy
  policy covering what the connector sees and stores, retention policy. Loop in legal.

### 1.4 Reliability & observability
- Structured logs shipped to a log store; **metrics** (request rate, 4xx/5xx, NetBird 429s,
  token issuance) and **tracing**; error tracking (e.g. Sentry).
- Alerting + on-call, uptime monitoring, and a basic **SLO** (e.g. 99.9% on `/mcp`).
- Per-tenant rate limiting is in place; add **global** protection for the auth endpoints and
  monitor aggregate NetBird API pressure across all tenants.

### 1.5 Product scope & guardrails for GA
- Confirm the **GA tool set** with Nima: keep it read-heavy; decide `delete_*` policy (recommend
  off by default even in GA, opt-in per deployment).
- Keep the **draft-and-confirm** flow on writes; consider an audit trail of connector-initiated
  changes (surface via `list_events`).
- Decide any **usage limits/fair-use** for the hosted service.

### 1.6 Distribution — two channels
- **Hosted remote connector** (the main ask): NetBird operates it; Cloud users just add the URL.
- **Published package for self-hosters & local users**: publish `@netbird/mcp` to npm and the
  Docker image to a public registry, with versioning and docs. (This also serves on-prem/self-host
  NetBird customers who can't use the hosted URL.)

### 1.7 Official Claude connector listing
- Submit to **Anthropic's connector directory** (partner process): branding/logo, description,
  privacy policy + terms URLs, and passing their security/technical review.
- Requires a stable public HTTPS server implementing the remote-MCP + OAuth spec (we do).
- Track this as a **partnership/BD track** in parallel — review timelines are external and not
  fully in our control.

### 1.8 Docs & support
- Customer setup guide (add connector → log in → first prompts), troubleshooting, and a support
  channel. Internal runbook for on-call.

### 1.9 Testing & QA
- Integration tests against a **dedicated NetBird test tenant** (real API, not mocks) in CI.
- Load test the hosted service; verify per-tenant isolation and 429 backoff under concurrency.

---

## 2. Phased rollout

| Phase | Outcome | Key work | Exit criteria |
|-------|---------|----------|---------------|
| **0. Decide & prep** | Green light | Pick auth path (§0); assign eng owner; pick domain + host; kick off legal | Decisions recorded; infra accounts ready |
| **1. Private beta** | Hosted, PAT-in-OAuth, a few friendly Cloud tenants | Persistent+encrypted store (§1.1); infra+CI/CD (§1.2); observability (§1.4); security basics (§1.3) | 3–5 real tenants using it; no token-handling gaps; dashboards live |
| **2. IdP federation** | Seamless "log in with NetBird" | ProxyOAuthServerProvider → NetBird auth app (§0/§1.1); pen test; GDPR/DPA (§1.3) | PAT no longer required; security review passed |
| **3. Public GA** | All Cloud users can self-serve | Finalize GA tool set (§1.5); docs+support (§1.8); publish npm+Docker (§1.6); load test (§1.9) | GA announced; self-host package published |
| **4. Official listing** | In Claude's connector directory | Anthropic submission + review + branding/legal (§1.7) | Listed and discoverable in Claude |

Phases 1 and the start of 2 can overlap; Phase 4 runs on Anthropic's timeline, so start the
conversation with them during Phase 2.

---

## 3. Cross-team dependencies (start early)
- **NetBird platform/auth team** — OAuth app registration + scopes for IdP federation (Phase 2 blocker).
- **NetBird eng** — a named owner for the service (this can't stay a Sales-owned prototype for GA).
- **Legal / DPO** — DPA, privacy policy, data-residency (EU).
- **Anthropic partnerships** — official directory listing (Phase 4).

## 4. Open decisions to record
1. Auth path for GA — **A now, B for GA** (recommended) vs. wait for B.
2. `delete_*` in GA — recommend **off by default**, opt-in.
3. Hosting platform + domain (align with NetBird's existing infra).
4. Who owns the service long-term (Sales prototype → eng ownership).
5. Hosted-only, or hosted **and** self-host package (recommend both).
```
