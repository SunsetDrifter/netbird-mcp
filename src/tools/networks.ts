import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, type ToolDeps } from "./registry.js";

export function registerNetworkTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_networks",
    title: "List networks",
    description:
      "List networks (the current connectivity model; the legacy Routes endpoint is deprecated " +
      "in favor of Networks).",
    path: () => "/api/networks",
  });

  registerRead(server, deps, {
    name: "get_network",
    title: "Get network",
    description: "Get one network in full, including its resources and routers.",
    inputSchema: { network_id: z.string().describe("The network ID.") },
    path: ({ network_id }) => `/api/networks/${encodeURIComponent(network_id)}`,
  });
}
