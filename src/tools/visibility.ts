import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, type ToolDeps } from "./registry.js";

export function registerVisibilityTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_posture_checks",
    title: "List posture checks",
    description:
      "List posture checks (OS version, geo, NetBird version requirements). Read-only in v1 — " +
      "authoring posture checks via chat is higher-risk and deferred.",
    path: () => "/api/posture-checks",
  });

  registerRead(server, deps, {
    name: "list_events",
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
    path: () => "/api/events",
    transformResponse: (data, { limit }) =>
      limit && Array.isArray(data) ? data.slice(0, limit) : data,
  });
}
