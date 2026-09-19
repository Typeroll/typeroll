import { z, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fail, ok, type ToolResult } from './tools/helpers.js';

export type ToolEffect = 'read' | 'write' | 'admin';
export interface CallableTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  effect: ToolEffect;
  invoke: (args: Record<string, unknown>) => Promise<ToolResult>;
}
export const COMPACT_INSTRUCTIONS = `Typeroll CMS. Use search_tools to find a task's tools, describe_tool to read one exact schema, then call_read_tool, call_write_tool or call_admin_tool. Discover before you write: identify Site/Version, capabilities and enabled app documentation. Read only the relevant skill or guide section; do not load the full manual by default. Larger changes: create_branch and keep the same version. Working copy, saved content and live output differ. Publishing and other external effects require the user's authorization; tool access alone is not approval.`;

/** Stable discovery surface: no dynamic registration or client list-change support needed. */
export function compactTools(catalog: CallableTool[]): CallableTool[] {
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  const local = (name: string, description: string, schema: ZodRawShape, invoke: CallableTool['invoke']): CallableTool => ({ name, description, schema, effect: 'read', invoke });
  return [
    local('search_tools', 'Find tools by name or task. Returns brief matches without schemas; use describe_tool next. Empty query lists names in pages.', {
      query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12).default(8),
    }, async args => {
      const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog.map(tool => ({ tool, score: words.reduce((sum, word) => sum + (tool.name === word ? 10 : tool.name.includes(word) ? 3 : tool.description.toLowerCase().includes(word) ? 1 : 0), 0) }))
        .filter(item => !words.length || item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const offset = Number(args.offset), limit = Number(args.limit);
      return ok({ tools: matches.slice(offset, offset + limit).map(({ tool }) => ({ name: tool.name, effect: tool.effect, description: tool.description.slice(0, 180) })), total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null });
    }),
    local('describe_tool', 'Read one tool’s complete description, effect and JSON input schema before calling it.', { name: z.string().max(100) }, async args => {
      const tool = byName.get(String(args.name));
      return tool ? ok({ name: tool.name, effect: tool.effect, description: tool.description, inputSchema: (zodToJsonSchema as (schema: unknown, options: { $refStrategy: 'none' }) => unknown)(z.object(tool.schema), { $refStrategy: 'none' }) }) : fail(new Error('Unknown tool. Use search_tools.'));
    }),
    ...(['read', 'write', 'admin'] as const).map(effect => ({
      name: `call_${effect}_tool`, effect,
      description: effect === 'read' ? 'Call a discovered read-only tool with its exact arguments. Does not accept write/admin tools.' : `Call a discovered ${effect} tool. May ${effect === 'admin' ? 'change app configuration or activate releases' : 'save, delete, publish or otherwise change state'}. Inspect describe_tool first and follow the user’s authorization.`,
      schema: { name: z.string().max(100), arguments: z.record(z.unknown()).default({}) },
      invoke: async (args: Record<string, unknown>) => {
        const tool = byName.get(String(args.name));
        if (!tool || tool.effect !== effect) return fail(new Error(`This endpoint accepts only ${effect} tools. Use describe_tool to check the required effect.`));
        try { return await tool.invoke(z.object(tool.schema).parse(args.arguments)); }
        catch (error) { return fail(error); }
      },
    })),
  ];
}
