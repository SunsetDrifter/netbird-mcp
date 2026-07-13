import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead, registerMutation, registerDelete, type ToolDeps } from "./registry.js";

// NetBird policy rules are rich; accept a structured-but-flexible shape and pass
// it through. The draft-and-confirm flow means the model shows the rule before it applies.
const ruleSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    action: z.enum(["accept", "drop"]).optional(),
    bidirectional: z.boolean().optional(),
    protocol: z.enum(["all", "tcp", "udp", "icmp"]).optional(),
    ports: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional().describe("Source group IDs."),
    destinations: z.array(z.string()).optional().describe("Destination group IDs."),
  })
  .passthrough();

export function registerPolicyTools(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, {
    name: "list_policies",
    title: "List policies",
    description:
      'List access policies — "what can talk to what." Second highest-value read tool.',
    path: () => "/api/policies",
  });

  registerRead(server, deps, {
    name: "get_policy",
    title: "Get policy",
    description: "Get one policy in full, including all its rules.",
    inputSchema: { policy_id: z.string().describe("The policy ID.") },
    path: ({ policy_id }) => `/api/policies/${encodeURIComponent(policy_id)}`,
  });

  registerMutation(server, deps, {
    name: "create_policy",
    title: "Create policy",
    description:
      "Create an access policy. Draft-and-confirm: preview shows the exact rule set; " +
      "apply with confirm=true.",
    inputSchema: {
      name: z.string().describe("Policy name."),
      description: z.string().optional(),
      enabled: z.boolean().optional().default(true),
      rules: z.array(ruleSchema).min(1).describe("One or more access rules."),
      confirm: z.boolean().optional().describe("Set true to create the policy."),
    },
    method: "POST",
    path: () => "/api/policies",
    previewAction: () => "Would create an access policy.",
    buildBody: ({ name, description, enabled, rules }) => ({ name, description, enabled, rules }),
  });

  registerMutation(server, deps, {
    name: "update_policy",
    title: "Update policy",
    description:
      "Update an access policy. Draft-and-confirm: preview shows the change; apply with confirm=true.",
    inputSchema: {
      policy_id: z.string().describe("The policy ID."),
      name: z.string().optional(),
      description: z.string().optional(),
      enabled: z.boolean().optional(),
      rules: z.array(ruleSchema).optional().describe("Full replacement rule set."),
      confirm: z.boolean().optional().describe("Set true to apply the change."),
    },
    method: "PUT",
    path: ({ policy_id }) => `/api/policies/${encodeURIComponent(policy_id)}`,
    previewAction: ({ policy_id }) => `Would update policy ${policy_id}.`,
    buildBody: ({ name, description, enabled, rules }) => ({ name, description, enabled, rules }),
  });

  registerDelete(server, deps, {
    name: "delete_policy",
    title: "Delete policy",
    description:
      "DESTRUCTIVE: delete an access policy. This can immediately change what peers can " +
      "reach each other. Requires the exact policy_id and confirm=true.",
    inputSchema: {
      policy_id: z.string().describe("The exact policy ID to delete."),
      confirm: z.boolean().describe("Must be true to delete."),
    },
    path: ({ policy_id }) => `/api/policies/${encodeURIComponent(policy_id)}`,
    label: "policy",
    idField: "policy_id",
  });
}
