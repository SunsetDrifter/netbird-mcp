import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, type ToolDeps } from "./registry.js";

export function registerDnsTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_nameserver_groups",
    title: "List nameserver groups",
    description: "List DNS nameserver groups configured for the network.",
    path: () => "/api/dns/nameservers",
  });

  registerRead(server, deps, {
    name: "get_dns_settings",
    title: "Get DNS settings",
    description: "Get account-level DNS settings. (DNS writes are deferred to v2.)",
    path: () => "/api/dns/settings",
  });
}
