import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NetBirdClient } from "../netbird/client.js";
import { NetBirdApiError } from "../netbird/client.js";
import type { ServerConfig } from "../config.js";
import type { Logger } from "../logger.js";

export interface ToolDeps {
  client: NetBirdClient;
  config: ServerConfig;
  logger: Logger;
}

/** Render a successful result as pretty JSON text content. */
export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Render an error result (isError so the model can react). */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A draft-and-confirm preview: when a mutating tool is called with confirm=false
 * we describe exactly what would happen instead of doing it. This is the
 * guardrail the proposal calls for on writes.
 */
export function preview(action: string, request: unknown): CallToolResult {
  return ok({
    status: "preview",
    message:
      `This is a preview — nothing was changed. ${action} ` +
      `Re-run with "confirm": true to apply.`,
    would_send: request,
  });
}

/** Wrap a tool handler so NetBird errors become clean tool errors, not crashes. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NetBirdApiError) {
      return fail(
        `NetBird API error (HTTP ${err.status}): ${err.message}\n` +
          (err.body ? JSON.stringify(err.body, null, 2) : ""),
      );
    }
    return fail(`Unexpected error: ${(err as Error).message}`);
  }
}
