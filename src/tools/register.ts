import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { registerPeerTools } from "./peers.js";
import { registerSetupKeyTools } from "./setupKeys.js";
import { registerGroupTools } from "./groups.js";
import { registerPolicyTools } from "./policies.js";
import { registerNetworkTools } from "./networks.js";
import { registerDnsTools } from "./dns.js";
import { registerVisibilityTools } from "./visibility.js";

/** Register the full v1 tool set on a server instance. */
export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerPeerTools(server, deps);
  registerSetupKeyTools(server, deps);
  registerGroupTools(server, deps);
  registerPolicyTools(server, deps);
  registerNetworkTools(server, deps);
  registerDnsTools(server, deps);
  registerVisibilityTools(server, deps);
}
