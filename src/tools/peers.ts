import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok, preview } from "./helpers.js";

export function registerPeerTools(server: McpServer, deps: ToolDeps): void {
  const { client, config } = deps;

  server.registerTool(
    "list_peers",
    {
      title: "List peers",
      description:
        "List peers on the NetBird network. The highest-value tool — answers most " +
        '"what is connected" questions. Optionally filter by name or IP.',
      inputSchema: {
        name: z.string().optional().describe("Filter by peer name (substring match)."),
        ip: z.string().optional().describe("Filter by peer IP address."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, ip }) =>
      guard(async () => ok(await client.get("/api/peers", { name, ip }))),
  );

  server.registerTool(
    "get_peer",
    {
      title: "Get peer",
      description:
        "Get full detail for one peer, including groups, OS, last-seen time and posture flags.",
      inputSchema: { peer_id: z.string().describe("The peer ID.") },
      annotations: { readOnlyHint: true },
    },
    async ({ peer_id }) =>
      guard(async () => ok(await client.get(`/api/peers/${encodeURIComponent(peer_id)}`))),
  );

  server.registerTool(
    "list_accessible_peers",
    {
      title: "List accessible peers",
      description:
        'Answer "can peer A reach peer B" — lists peers the given peer can reach under ' +
        "current policies, without a live trace.",
      inputSchema: { peer_id: z.string().describe("The source peer ID.") },
      annotations: { readOnlyHint: true },
    },
    async ({ peer_id }) =>
      guard(async () =>
        ok(await client.get(`/api/peers/${encodeURIComponent(peer_id)}/accessible-peers`)),
      ),
  );

  server.registerTool(
    "update_peer",
    {
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
        confirm: z.boolean().optional().describe("Set true to apply the change."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ peer_id, confirm, ...fields }) =>
      guard(async () => {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        );
        if (!confirm) return preview(`Would update peer ${peer_id}.`, body);
        return ok(await client.put(`/api/peers/${encodeURIComponent(peer_id)}`, body));
      }),
  );

  if (config.enableDestructive) {
    server.registerTool(
      "delete_peer",
      {
        title: "Delete peer",
        description:
          "DESTRUCTIVE: permanently remove a peer from the network. Requires the exact " +
          "peer_id and confirm=true. Never call this on a batch or filtered set — one peer, " +
          "named explicitly by the user.",
        inputSchema: {
          peer_id: z.string().describe("The exact peer ID to delete."),
          confirm: z.boolean().describe("Must be true to delete."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ peer_id, confirm }) =>
        guard(async () => {
          if (!confirm) return preview(`Would DELETE peer ${peer_id}.`, { peer_id });
          await client.delete(`/api/peers/${encodeURIComponent(peer_id)}`);
          return ok({ status: "deleted", peer_id });
        }),
    );
  }
}
