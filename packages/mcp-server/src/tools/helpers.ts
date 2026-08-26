// Shared helpers for tool handlers.

import { z } from 'zod';
import { ApiError, type TyperollClient } from '../client.js';

export interface ToolDeps {
  client: TyperollClient;
  /** The siteId every tool will operate against. Resolved once at server
   *  startup from `TYPEROLL_SITE_ID` env var (if present) or by calling
   *  `GET /v1/sites` and picking the single result. */
  siteId: string;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Format an arbitrary result as MCP tool output. Pretty-print JSON because
 *  Claude renders code blocks well and we want the model to see structured
 *  shapes, not blobby unfolded strings. */
export function ok(data: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Turn an API error into a structured tool error. Preserves the status
 *  code so the agent can decide between "retry" and "give up". */
export function fail(err: unknown): ToolResult {
  if (err instanceof ApiError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: err.message,
              status: err.status,
              body: err.body,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      { type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

/** Tool definition shape consumed by index.ts when registering. */
export interface ToolDef<Input extends z.ZodRawShape | undefined = z.ZodRawShape | undefined> {
  name: string;
  description: string;
  inputSchema?: Input;
  /** When true the tool operates without a site context — in multi-site
   *  (hosted) mode the server does NOT inject/validate a `site_id` arg for
   *  it. Used by the skill-discovery tools, which are pure local file reads
   *  that don't touch the REST API or any particular site. */
  noSite?: boolean;
  handler: (
    args: Input extends z.ZodRawShape ? z.objectOutputType<Input, z.ZodTypeAny> : Record<string, never>,
    deps: ToolDeps,
  ) => Promise<ToolResult>;
}

/** Convenience to wrap a handler so all API errors become structured tool
 *  errors instead of throwing — Claude Code displays the result more
 *  usefully when isError is set. */
export function withErrorBoundary<T extends z.ZodRawShape | undefined>(
  handler: ToolDef<T>['handler'],
): ToolDef<T>['handler'] {
  return async (args, deps) => {
    try {
      return await handler(args, deps);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Shared zod fragment for the optional `version` parameter. */
export const versionParam = z
  .string()
  .optional()
  .describe('Branch id to target. Omit for main.');
