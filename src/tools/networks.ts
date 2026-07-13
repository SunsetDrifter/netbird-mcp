import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok } from "./helpers.js";

export function registerNetworkTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    "list_networks",
    {
      title: "List networks",
      description:
        "List networks (the current connectivity model; the legacy Routes endpoint is deprecated " +
        "in favor of Networks).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/networks"))),
  );

  server.registerTool(
    "get_network",
    {
      title: "Get network",
      description: "Get one network in full, including its resources and routers.",
      inputSchema: { network_id: z.string().describe("The network ID.") },
      annotations: { readOnlyHint: true },
    },
    async ({ network_id }) =>
      guard(async () => ok(await client.get(`/api/networks/${encodeURIComponent(network_id)}`))),
  );
}
