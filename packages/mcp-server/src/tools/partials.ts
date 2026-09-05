// Partials (global blocks) tools.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const partialTools: ToolDef[] = [
  {
    name: 'list_partials',
    description:
      'List global blocks (header, footer, free blocks). Defaults to summary mode (no html_content, just metadata + byte count) to keep agent context lean — pass include_content: true if you actually want the bodies inline, otherwise call read_partial on the one you care about.',
    inputSchema: {
      include_content: z.boolean().optional().describe('Include full html_content in the response. Default false.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'partials', {
        ...(args.include_content ? {} : { summary: 'true' }),
        ...v(args.version),
      });
      return ok(res);
    }),
  },
  {
    name: 'read_partial',
    description: 'Fetch one global block including its content_mode and the active HTML or block tree.',
    inputSchema: {
      partial_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `partials/${encodeURIComponent(args.partial_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'update_partial',
    description:
      'Shallow-merge update on a global block. Use partial_id "header" or "footer" for the auto-injected layout blocks, or a kebab-case id for a free block. HTML is sanitized server-side. This tool does not accept content_mode; switch it with set_partial_mode. BUFFER MODEL: content lands in the partial\'s unsaved DRAFT (status applies immediately); pass save:true to commit in the same call, or commit_working_copy later.',
    inputSchema: {
      partial_id: z.string(),
      patch: z
        .object({
          name: z.string().optional(),
          html_content: z.string().optional(),
          blocks: z.array(z.any()).optional().describe('Block tree to stage before switching the partial to blocks mode.'),
          status: z.enum(['draft', 'published']).optional(),
          kind: z.enum(['header', 'footer', 'free']).optional(),
        })
        .passthrough(),
      save: z.boolean().optional().describe('Also SAVE (commit) the draft in the same call.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.patch(
        siteId,
        `partials/${encodeURIComponent(args.partial_id)}`,
        { ...args.patch, ...(args.save ? { save: true } : {}) },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'set_partial_mode',
    description:
      'Switch a header, footer, or free partial between HTML and native blocks through the revision-safe mode endpoint. To author a native partial deterministically: update_partial with blocks + save:true, then set_partial_mode to="blocks", then read_partial and verify the returned mode/tree. Set convert:true only for heuristic HTML-to-block conversion.',
    inputSchema: {
      partial_id: z.string(),
      to: z.enum(['blocks', 'html']),
      convert: z.boolean().optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `partials/${encodeURIComponent(args.partial_id)}/mode`,
        { to: args.to, convert: args.convert ?? false },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'replace_partial',
    description:
      'Full replace of a global block (PUT). Pass html_content (and optionally name/status) directly — no wrapper object needed. ' +
      'kind is auto-inferred from partial_id ("header" → header, "footer" → footer, anything else → free). ' +
      'For incremental edits (changing one field without replacing the whole block) use update_partial instead. ' +
      'BUFFER MODEL: content lands in the partial\'s unsaved DRAFT; pass save:true to commit in the same call.',
    inputSchema: {
      partial_id: z.string().describe('"header", "footer", or a free-block kebab-id.'),
      html_content: z.string().describe('Full HTML for the block. Replaces any existing content.'),
      name: z.string().optional().describe('Human-readable label shown in the UI.'),
      status: z.enum(['draft', 'published']).optional(),
      save: z.boolean().optional().describe('Also SAVE (commit) the draft in the same call.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, partial_id, ...fields } = args;
      const res = await client.put(
        siteId,
        `partials/${encodeURIComponent(partial_id)}`,
        fields,
        v(version),
      );
      return ok(res);
    }),
  },
  {
    name: 'create_free_block',
    description:
      'Create a new free (reusable) global block. Use a kebab-case id and embed it on pages with <x-include name="block-id" />.',
    inputSchema: {
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      name: z.string().optional(),
      html_content: z.string(),
      status: z.enum(['draft', 'published']).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'partials', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'delete_partial',
    description: 'Delete a free global block. header and footer cannot be deleted (they are layout blocks).',
    inputSchema: {
      partial_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `partials/${encodeURIComponent(args.partial_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'find_pages_using_block',
    description:
      'Pages that embed a given block via <x-include name="…">. For partial_id "header" or "footer" returns the full page list (they are auto-injected on every page). Use this to know the blast radius before editing a shared block.',
    inputSchema: {
      partial_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `partials/${encodeURIComponent(args.partial_id)}/usage`,
        v(args.version),
      );
      return ok(res);
    }),
  },
];
