import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, registerMutation, registerDelete, type ToolDeps } from "./registry.js";

export function registerGroupTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_groups",
    title: "List groups",
    description: "List groups. Groups are the unit access policies are written against.",
    path: () => "/api/groups",
  });

  registerMutation(server, deps, {
    name: "create_group",
    title: "Create group",
    description: "Create a group, optionally with an initial set of peers. Preview first; apply with confirm=true.",
    inputSchema: {
      name: z.string().describe("Group name."),
      peers: z.array(z.string()).optional().describe("Peer IDs to place in the group."),
      confirm: z.boolean().optional().describe("Set true to create the group."),
    },
    method: "POST",
    path: () => "/api/groups",
    previewAction: () => "Would create a group.",
    buildBody: ({ name, peers }) => ({ name, peers }),
  });

  registerMutation(server, deps, {
    name: "update_group",
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
    method: "PUT",
    path: ({ group_id }) => `/api/groups/${encodeURIComponent(group_id)}`,
    previewAction: ({ group_id }) => `Would update group ${group_id}.`,
    buildBody: ({ name, peers }) => ({ name, peers }),
  });

  registerDelete(server, deps, {
    name: "delete_group",
    title: "Delete group",
    description:
      "DESTRUCTIVE: delete a group. Fails if the group is still referenced by a policy or " +
      "route. Requires the exact group_id and confirm=true.",
    inputSchema: {
      group_id: z.string().describe("The exact group ID to delete."),
      confirm: z.boolean().describe("Must be true to delete."),
    },
    path: ({ group_id }) => `/api/groups/${encodeURIComponent(group_id)}`,
    label: "group",
    idField: "group_id",
  });
}
