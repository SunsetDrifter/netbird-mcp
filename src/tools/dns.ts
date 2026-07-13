import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok } from "./helpers.js";

export function registerDnsTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    "list_nameserver_groups",
    {
      title: "List nameserver groups",
      description: "List DNS nameserver groups configured for the network.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/dns/nameservers"))),
  );

  server.registerTool(
    "get_dns_settings",
    {
      title: "Get DNS settings",
      description: "Get account-level DNS settings. (DNS writes are deferred to v2.)",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/dns/settings"))),
  );
}
