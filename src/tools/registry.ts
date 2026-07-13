import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat, ShapeOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
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

/**
 * The registration interface is the only path by which tools reach the MCP
 * server. It owns the draft-and-confirm guardrail (registerMutation,
 * registerDelete), the destructive-tools gate (registerDelete), and the
 * NetBird-error-to-tool-error translation (all three) — so a new tool gets
 * these for free just by being written as a manifest, and cannot skip them.
 */

interface ManifestBase<Args extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  inputSchema?: Args;
}

export interface ReadManifest<Args extends ZodRawShapeCompat = Record<string, never>>
  extends ManifestBase<Args> {
  path: (args: ShapeOutput<Args>) => string;
  /** Query string params for the GET request. */
  query?: (args: ShapeOutput<Args>) => Record<string, string | number | boolean | undefined>;
  /** Post-process the raw response before rendering it, e.g. a client-side limit. */
  transformResponse?: (data: unknown, args: ShapeOutput<Args>) => unknown;
}

export interface MutationManifest<Args extends ZodRawShapeCompat> extends ManifestBase<Args> {
  inputSchema: Args;
  method: "POST" | "PUT";
  path: (args: ShapeOutput<Args>) => string;
  /** The draft-and-confirm preview line, e.g. "Would create a group." */
  previewAction: (args: ShapeOutput<Args>) => string;
  /**
   * Build the request body from parsed args. Fields left `undefined` are
   * dropped before the body is shown in the preview or sent to NetBird, so
   * hooks can pass every optional field through unconditionally.
   */
  buildBody: (args: ShapeOutput<Args>) => Record<string, unknown>;
}

export interface DeleteManifest<Args extends ZodRawShapeCompat> extends ManifestBase<Args> {
  inputSchema: Args;
  path: (args: ShapeOutput<Args>) => string;
  /** Domain label used in generated preview/result text, e.g. "peer". */
  label: string;
  /** Name of the id field in inputSchema, e.g. "peer_id". */
  idField: string;
}

/** Render a successful result as pretty JSON text content. */
function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Render an error result (isError so the model can react). */
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A draft-and-confirm preview: when a mutating tool is called with confirm=false
 * we describe exactly what would happen instead of doing it. This is the
 * guardrail the product promises on every write.
 */
function preview(action: string, request: unknown): CallToolResult {
  return ok({
    status: "preview",
    message:
      `This is a preview — nothing was changed. ${action} ` +
      `Re-run with "confirm": true to apply.`,
    would_send: request,
  });
}

/** Wrap a tool handler so NetBird errors become clean tool errors, not crashes. */
async function guard(logger: Logger, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NetBirdApiError) {
      return fail(
        `NetBird API error (HTTP ${err.status}): ${err.message}\n` +
          (err.body ? JSON.stringify(err.body, null, 2) : ""),
      );
    }
    // Unexpected (non-API) failure: the caller gets a clean message, the
    // operator gets the details — never swallow the context.
    const error = err as Error;
    logger.error("unexpected tool error", { message: error.message, stack: error.stack });
    return fail(`Unexpected error: ${error.message}`);
  }
}

/** Drop fields whose value is `undefined`, without mutating the input. */
function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

function isConfirmed(args: ShapeOutput<ZodRawShapeCompat>): boolean {
  return (args as Record<string, unknown>).confirm === true;
}

/** The single field name the draft-and-confirm guardrail owns. */
const CONFIRM_FIELD = "confirm";

/**
 * The guardrail field a mutation advertises: optional, because a mutation
 * previews when it is omitted and applies when it is true.
 */
const MUTATION_CONFIRM = z.boolean().optional().describe("Set true to apply the change.");

/**
 * The guardrail field a delete advertises: required, so a delete cannot be
 * issued without explicitly opting in.
 */
const DELETE_CONFIRM = z.boolean().describe("Must be true to delete.");

/**
 * Return a new input shape with the guardrail's `confirm` field injected, so
 * every write tool advertises confirm without its manifest declaring one. The
 * manifest's own schema is never mutated. Throws if the manifest already
 * declares `confirm` — a manifest may only declare domain fields, so the
 * guardrail field can never silently collide with one.
 */
function withConfirmField<Args extends ZodRawShapeCompat>(
  inputSchema: Args,
  confirmSchema: z.ZodTypeAny,
): Args {
  if (Object.prototype.hasOwnProperty.call(inputSchema, CONFIRM_FIELD)) {
    throw new Error(
      `Tool manifest declares its own "${CONFIRM_FIELD}" field; the registry injects ` +
        "the draft-and-confirm guardrail, so manifests must declare only domain fields.",
    );
  }
  return { ...inputSchema, [CONFIRM_FIELD]: confirmSchema } as unknown as Args;
}

/** Register a read-only tool: a straight GET, optionally with query params or a response transform. */
export function registerRead<Args extends ZodRawShapeCompat = Record<string, never>>(
  server: McpServer,
  deps: ToolDeps,
  manifest: ReadManifest<Args>,
): void {
  server.registerTool(
    manifest.name,
    {
      title: manifest.title,
      description: manifest.description,
      inputSchema: manifest.inputSchema ?? ({} as Args),
      annotations: { readOnlyHint: true },
    },
    (async (args: ShapeOutput<Args>) =>
      guard(deps.logger, async () => {
        const data = await deps.client.get(manifest.path(args), manifest.query?.(args));
        return ok(manifest.transformResponse ? manifest.transformResponse(data, args) : data);
      })) as unknown as ToolCallback<Args>,
  );
}

/**
 * Register a mutating (create/update) tool. Owns the whole guardrail: no
 * confirm means a preview and zero API calls; confirm sends the body — with
 * undefined fields stripped — via the declared method and path.
 */
export function registerMutation<Args extends ZodRawShapeCompat>(
  server: McpServer,
  deps: ToolDeps,
  manifest: MutationManifest<Args>,
): void {
  server.registerTool(
    manifest.name,
    {
      title: manifest.title,
      description: manifest.description,
      inputSchema: withConfirmField(manifest.inputSchema, MUTATION_CONFIRM),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (async (args: ShapeOutput<Args>) =>
      guard(deps.logger, async () => {
        const body = stripUndefined(manifest.buildBody(args));
        if (!isConfirmed(args)) return preview(manifest.previewAction(args), body);
        const path = manifest.path(args);
        const response =
          manifest.method === "POST"
            ? await deps.client.post(path, body)
            : await deps.client.put(path, body);
        return ok(response);
      })) as unknown as ToolCallback<Args>,
  );
}

/**
 * Register a destructive delete tool. Registers nothing when destructive
 * operations are disabled in server configuration; when enabled, still
 * requires draft-and-confirm — enabling the feature never bypasses the guardrail.
 */
export function registerDelete<Args extends ZodRawShapeCompat>(
  server: McpServer,
  deps: ToolDeps,
  manifest: DeleteManifest<Args>,
): void {
  // Build the advertised schema first: the collision guard is a manifest-
  // correctness check, so it must fire even in read-only deployments where the
  // tool is never registered.
  const inputSchema = withConfirmField(manifest.inputSchema, DELETE_CONFIRM);
  if (!deps.config.enableDestructive) return;

  server.registerTool(
    manifest.name,
    {
      title: manifest.title,
      description: manifest.description,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (async (args: ShapeOutput<Args>) =>
      guard(deps.logger, async () => {
        const idValue = (args as Record<string, unknown>)[manifest.idField];
        if (!isConfirmed(args)) {
          return preview(`Would DELETE ${manifest.label} ${idValue}.`, {
            [manifest.idField]: idValue,
          });
        }
        await deps.client.delete(manifest.path(args));
        return ok({ status: "deleted", [manifest.idField]: idValue });
      })) as unknown as ToolCallback<Args>,
  );
}
