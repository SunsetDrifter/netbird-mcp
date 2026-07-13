import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok } from "./helpers.js";

export function registerVisibilityTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    "list_posture_checks",
    {
      title: "List posture checks",
      description:
        "List posture checks (OS version, geo, NetBird version requirements). Read-only in v1 — " +
        "authoring posture checks via chat is higher-risk and deferred.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/posture-checks"))),
  );

  server.registerTool(
    "list_events",
    {
      title: "List audit events",
      description:
        'The audit log — "what changed on this peer/policy in the last 24h." High value for ' +
        "troubleshooting. Returns recent account activity events.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Client-side cap on number of events returned (most recent first)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        const events = await client.get<unknown[]>("/api/events");
        if (limit && Array.isArray(events)) return ok(events.slice(0, limit));
        return ok(events);
      }),
  );
}
