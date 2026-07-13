import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, registerMutation, registerDelete, type ToolDeps } from "./registry.js";

export function registerPeerTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_peers",
    title: "List peers",
    description:
      "List peers on the NetBird network. The highest-value tool — answers most " +
      '"what is connected" questions. Optionally filter by name or IP.',
    inputSchema: {
      name: z.string().optional().describe("Filter by peer name (substring match)."),
      ip: z.string().optional().describe("Filter by peer IP address."),
    },
    path: () => "/api/peers",
    query: ({ name, ip }) => ({ name, ip }),
  });

  registerRead(server, deps, {
    name: "get_peer",
    title: "Get peer",
    description:
      "Get full detail for one peer, including groups, OS, last-seen time and posture flags.",
    inputSchema: { peer_id: z.string().describe("The peer ID.") },
    path: ({ peer_id }) => `/api/peers/${encodeURIComponent(peer_id)}`,
  });

  registerRead(server, deps, {
    name: "list_accessible_peers",
    title: "List accessible peers",
    description:
      'Answer "can peer A reach peer B" — lists peers the given peer can reach under ' +
      "current policies, without a live trace.",
    inputSchema: { peer_id: z.string().describe("The source peer ID.") },
    path: ({ peer_id }) => `/api/peers/${encodeURIComponent(peer_id)}/accessible-peers`,
  });

  registerMutation(server, deps, {
    name: "update_peer",
    title: "Update peer",
    description:
      "Update a peer: rename, toggle SSH, approval, or login-expiration. " +
      "A write — call once with confirm omitted/false to preview the change, then " +
      "again with confirm=true to apply.",
    inputSchema: {
      peer_id: z.string().describe("The peer ID."),
      name: z.string().optional().describe("New peer name."),
      ssh_enabled: z.boolean().optional().describe("Enable/disable SSH server on the peer."),
      login_expiration_enabled: z
        .boolean()
        .optional()
        .describe("Enable/disable periodic login expiration."),
      approval_required: z
        .boolean()
        .optional()
        .describe("Whether the peer requires approval."),
    },
    method: "PUT",
    path: ({ peer_id }) => `/api/peers/${encodeURIComponent(peer_id)}`,
    previewAction: ({ peer_id }) => `Would update peer ${peer_id}.`,
    buildBody: ({ name, ssh_enabled, login_expiration_enabled, approval_required }) => ({
      name,
      ssh_enabled,
      login_expiration_enabled,
      approval_required,
    }),
  });

  registerDelete(server, deps, {
    name: "delete_peer",
    title: "Delete peer",
    description:
      "DESTRUCTIVE: permanently remove a peer from the network. Requires the exact " +
      "peer_id and confirm=true. Never call this on a batch or filtered set — one peer, " +
      "named explicitly by the user.",
    inputSchema: {
      peer_id: z.string().describe("The exact peer ID to delete."),
    },
    path: ({ peer_id }) => `/api/peers/${encodeURIComponent(peer_id)}`,
    label: "peer",
    idField: "peer_id",
  });
}
