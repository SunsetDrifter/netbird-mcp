import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDeps, guard, ok, preview } from "./helpers.js";

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
  const { client, config } = deps;

  server.registerTool(
    "list_policies",
    {
      title: "List policies",
      description:
        'List access policies — "what can talk to what." Second highest-value read tool.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => ok(await client.get("/api/policies"))),
  );

  server.registerTool(
    "get_policy",
    {
      title: "Get policy",
      description: "Get one policy in full, including all its rules.",
      inputSchema: { policy_id: z.string().describe("The policy ID.") },
      annotations: { readOnlyHint: true },
    },
    async ({ policy_id }) =>
      guard(async () => ok(await client.get(`/api/policies/${encodeURIComponent(policy_id)}`))),
  );

  server.registerTool(
    "create_policy",
    {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, description, enabled, rules, confirm }) =>
      guard(async () => {
        const body = { name, description, enabled, rules };
        if (!confirm) return preview("Would create an access policy.", body);
        return ok(await client.post("/api/policies", body));
      }),
  );

  server.registerTool(
    "update_policy",
    {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ policy_id, confirm, ...fields }) =>
      guard(async () => {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        );
        if (!confirm) return preview(`Would update policy ${policy_id}.`, body);
        return ok(await client.put(`/api/policies/${encodeURIComponent(policy_id)}`, body));
      }),
  );

  if (config.enableDestructive) {
    server.registerTool(
      "delete_policy",
      {
        title: "Delete policy",
        description:
          "DESTRUCTIVE: delete an access policy. This can immediately change what peers can " +
          "reach each other. Requires the exact policy_id and confirm=true.",
        inputSchema: {
          policy_id: z.string().describe("The exact policy ID to delete."),
          confirm: z.boolean().describe("Must be true to delete."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ policy_id, confirm }) =>
        guard(async () => {
          if (!confirm) return preview(`Would DELETE policy ${policy_id}.`, { policy_id });
          await client.delete(`/api/policies/${encodeURIComponent(policy_id)}`);
          return ok({ status: "deleted", policy_id });
        }),
    );
  }
}
