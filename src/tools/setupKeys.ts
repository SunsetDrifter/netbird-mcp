import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok, preview } from "./helpers.js";

export function registerSetupKeyTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    "list_setup_keys",
    {
      title: "List setup keys",
      description: "List setup keys (active, expired and revoked) used to enroll new peers.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/setup-keys"))),
  );

  server.registerTool(
    "create_setup_key",
    {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, type, expires_in_seconds, auto_groups, usage_limit, ephemeral, confirm }) =>
      guard(async () => {
        const body = {
          name,
          type,
          expires_in: expires_in_seconds,
          auto_groups: auto_groups ?? [],
          ...(usage_limit !== undefined ? { usage_limit } : {}),
          ...(ephemeral !== undefined ? { ephemeral } : {}),
        };
        if (!confirm) return preview("Would create a setup key.", body);
        return ok(await client.post("/api/setup-keys", body));
      }),
  );

  server.registerTool(
    "update_setup_key",
    {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ key_id, revoked, auto_groups, confirm }) =>
      guard(async () => {
        const body = {
          ...(revoked !== undefined ? { revoked } : {}),
          ...(auto_groups !== undefined ? { auto_groups } : {}),
        };
        if (!confirm) return preview(`Would update setup key ${key_id}.`, body);
        return ok(await client.put(`/api/setup-keys/${encodeURIComponent(key_id)}`, body));
      }),
  );
}
