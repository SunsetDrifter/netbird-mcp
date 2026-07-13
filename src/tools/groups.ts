import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok, preview } from "./helpers.js";

export function registerGroupTools(server: McpServer, deps: ToolDeps): void {
  const { client, config } = deps;

  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description: "List groups. Groups are the unit access policies are written against.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/groups"))),
  );

  server.registerTool(
    "create_group",
    {
      title: "Create group",
      description: "Create a group, optionally with an initial set of peers. Preview first; apply with confirm=true.",
      inputSchema: {
        name: z.string().describe("Group name."),
        peers: z.array(z.string()).optional().describe("Peer IDs to place in the group."),
        confirm: z.boolean().optional().describe("Set true to create the group."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, peers, confirm }) =>
      guard(async () => {
        const body = { name, ...(peers !== undefined ? { peers } : {}) };
        if (!confirm) return preview("Would create a group.", body);
        return ok(await client.post("/api/groups", body));
      }),
  );

  server.registerTool(
    "update_group",
    {
      title: "Update group",
      description:
        "Update a group — rename or replace its peer membership. Note: peers is the full " +
        "replacement list, not a delta. Preview first; apply with confirm=true.",
      inputSchema: {
        group_id: z.string().describe("The group ID."),
        name: z.string().optional().describe("New group name."),
        peers: z
          .array(z.string())
          .optional()
          .describe("Full replacement list of peer IDs in the group."),
        confirm: z.boolean().optional().describe("Set true to apply the change."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ group_id, name, peers, confirm }) =>
      guard(async () => {
        const body = {
          ...(name !== undefined ? { name } : {}),
          ...(peers !== undefined ? { peers } : {}),
        };
        if (!confirm) return preview(`Would update group ${group_id}.`, body);
        return ok(await client.put(`/api/groups/${encodeURIComponent(group_id)}`, body));
      }),
  );

  if (config.enableDestructive) {
    server.registerTool(
      "delete_group",
      {
        title: "Delete group",
        description:
          "DESTRUCTIVE: delete a group. Fails if the group is still referenced by a policy or " +
          "route. Requires the exact group_id and confirm=true.",
        inputSchema: {
          group_id: z.string().describe("The exact group ID to delete."),
          confirm: z.boolean().describe("Must be true to delete."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ group_id, confirm }) =>
        guard(async () => {
          if (!confirm) return preview(`Would DELETE group ${group_id}.`, { group_id });
          await client.delete(`/api/groups/${encodeURIComponent(group_id)}`);
          return ok({ status: "deleted", group_id });
        }),
    );
  }
}
