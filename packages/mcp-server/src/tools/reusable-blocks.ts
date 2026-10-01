// Reusable blocks: global blocks (one shared source, referenced) and block
// templates (saved starters, copied in). Global blocks themselves are
// partials; see partials.ts for list/read/update/delete.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const reusableBlockTools: ToolDef[] = [
  {
    name: 'make_block_global',
    description:
      'Turn a block on a page (with everything inside it) into a global block and put a reference in its place. Other pages then add the same block with add_block type "core/global_block" data { global_block_id }. Editing the global block (update_partial / update_block with target { kind: "partial", id }) changes every page that uses it. Use for content that must stay identical everywhere, such as a shared call to action. Writes the page draft.',
    inputSchema: {
      page_id: z.string(),
      block_id: z.string(),
      name: z.string().optional().describe('Name editors see; defaults to the block name.'),
      global_block_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional().describe('Id for the new global block; derived from the name when omitted.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { page_id, version, ...body } = args;
      return ok(await client.post(siteId, `pages/${encodeURIComponent(page_id)}/blocks/make-global`, body, v(version)));
    }),
  },
  {
    name: 'detach_global_block',
    description:
      'Replace a core/global_block reference on a page with an editable copy of the global block\'s blocks. Later edits to the global block no longer reach this page. Writes the page draft.',
    inputSchema: {
      page_id: z.string(),
      block_id: z.string().describe('The id of the core/global_block reference block.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { page_id, version, ...body } = args;
      return ok(await client.post(siteId, `pages/${encodeURIComponent(page_id)}/blocks/detach`, body, v(version)));
    }),
  },
  {
    name: 'list_block_templates',
    description:
      'List the site\'s block templates: saved section starters (name, description, block count). Inserting one copies its blocks into a page, where they are then edited independently. Check here before building a common section from scratch.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'block-templates'))),
  },
  {
    name: 'read_block_template',
    description: 'Read one block template, including its block tree.',
    inputSchema: { template_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `block-templates/${encodeURIComponent(args.template_id)}`))),
  },
  {
    name: 'save_block_template',
    description:
      'Save a block template: a section starter that editors and agents insert as an independent copy. Pass `from: { page_id, block_id }` to save a block from a page (its draft), or `blocks`. Prefer templates that use named styles (style_id) over one-off values, so copies stay consistent. Templates belong to the site, not a branch.',
    inputSchema: {
      name: z.string(),
      description: z.string().optional().describe('When to use it.'),
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
      from: z.object({ page_id: z.string(), block_id: z.string() }).optional(),
      blocks: z.array(z.record(z.unknown())).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'block-templates', args))),
  },
  {
    name: 'update_block_template',
    description: 'Rename a block template, change its description, or replace its blocks. Pages that already inserted it do not change.',
    inputSchema: {
      template_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      blocks: z.array(z.record(z.unknown())).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { template_id, ...body } = args;
      return ok(await client.patch(siteId, `block-templates/${encodeURIComponent(template_id)}`, body));
    }),
  },
  {
    name: 'delete_block_template',
    description: 'Delete a block template. Pages that already inserted it keep their copies.',
    inputSchema: { template_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `block-templates/${encodeURIComponent(args.template_id)}`))),
  },
  {
    name: 'insert_block_template',
    description:
      'Insert a copy of a block template into a page (new block ids), at the top level or inside parent_id (slot_index for column slots), at `position` (default: end). Returns added_ids. Writes the page draft.',
    inputSchema: {
      page_id: z.string(),
      template_id: z.string(),
      parent_id: z.string().optional().nullable(),
      slot_index: z.number().int().min(0).optional(),
      position: z.number().int().min(0).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { page_id, version, ...body } = args;
      return ok(await client.post(siteId, `pages/${encodeURIComponent(page_id)}/blocks/insert-template`, body, v(version)));
    }),
  },
];
