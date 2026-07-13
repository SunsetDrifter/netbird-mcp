import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, registerMutation, type ToolDeps } from "./registry.js";

export function registerSetupKeyTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_setup_keys",
    title: "List setup keys",
    description: "List setup keys (active, expired and revoked) used to enroll new peers.",
    path: () => "/api/setup-keys",
  });

  registerMutation(server, deps, {
    name: "create_setup_key",
    title: "Create setup key",
    description:
      'Create a setup key for enrolling new peers, e.g. "a key for the new contractor ' +
      'laptop, expiring in 7 days." Additive and low-risk. Preview first; apply with confirm=true.',
    inputSchema: {
      name: z.string().describe("Human-readable name for the key."),
      type: z
        .enum(["reusable", "one-off"])
        .default("one-off")
        .describe("reusable (many peers) or one-off (single peer)."),
      expires_in_seconds: z
        .number()
        .int()
        .positive()
        .describe("Lifetime in seconds. e.g. 604800 for 7 days."),
      auto_groups: z
        .array(z.string())
        .optional()
        .describe("Group IDs peers enrolled with this key are auto-added to."),
      usage_limit: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Max uses (0 = unlimited). Only meaningful for reusable keys."),
      ephemeral: z
        .boolean()
        .optional()
        .describe("If true, peers are removed shortly after going offline."),
      confirm: z.boolean().optional().describe("Set true to create the key."),
    },
    method: "POST",
    path: () => "/api/setup-keys",
    previewAction: () => "Would create a setup key.",
    // NetBird's API calls the field `expires_in`; the tool's own vocabulary is
    // explicit about the unit. auto_groups defaults to [] rather than being omitted.
    buildBody: ({ name, type, expires_in_seconds, auto_groups, usage_limit, ephemeral }) => ({
      name,
      type,
      expires_in: expires_in_seconds,
      auto_groups: auto_groups ?? [],
      usage_limit,
      ephemeral,
    }),
  });

  registerMutation(server, deps, {
    name: "update_setup_key",
    title: "Update setup key",
    description:
      "Update a setup key — mainly to revoke a compromised key. Preview first; apply with confirm=true.",
    inputSchema: {
      key_id: z.string().describe("The setup key ID."),
      revoked: z.boolean().optional().describe("Set true to revoke the key."),
      auto_groups: z
        .array(z.string())
        .optional()
        .describe("Replacement list of auto-assigned group IDs."),
      confirm: z.boolean().optional().describe("Set true to apply the change."),
    },
    method: "PUT",
    path: ({ key_id }) => `/api/setup-keys/${encodeURIComponent(key_id)}`,
    previewAction: ({ key_id }) => `Would update setup key ${key_id}.`,
    buildBody: ({ revoked, auto_groups }) => ({ revoked, auto_groups }),
  });
}
