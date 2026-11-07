// The organization collection: templates, sections, page templates, global
// blocks, block types and whole packages stored once for an organization and
// inserted into any of its sites. Each tool maps onto
// /api/v1/sites/{siteId}/collection/*; the site names the organization whose
// collection it is and the site an insert goes into.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef } from './helpers.js';

const v = (version?: string) => (version ? { version } : undefined);
const entryId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).describe('Entry id from list_collection_entries.');

const WHO =
  'The collection belongs to the site\'s organization and is visible to its owners, administrators and builders; a client given one site through a share never sees it (404), nor does a site-scoped key. Typeroll\'s built-in starters are listed as read-only entries.';
const STYLES =
  'Inserting is a package import: every style the entry uses is created on the site, never mapped to a "nearest" style; a differing style with the same id is created under a new id (hero-2, "Hero (imported)") and the inserted content is rewritten to it. Block types and global blocks follow the same rule; media is copied into the site\'s Media library.';

export const collectionTools: ToolDef[] = [
  {
    name: 'list_collection_entries',
    description:
      'List the organization collection: { entries: [{ id, kind (section | block_template | page_template | global_block | block_type | package), name, description, category, preview_url, languages, source ({ type: site | package | builtin | app, publisher, verified, extension_id }), read_only, updated_at, summary: { block_count, top_level_types, styles, block_types, media } }] }. ' +
      WHO + ' Insert an entry with insert_from_collection.',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'collection', v(args.version)))),
  },
  {
    name: 'read_collection_entry',
    description: 'Read one collection entry with its whole package (blocks, styles, block types, global blocks, media list).',
    inputSchema: { entry_id: entryId, version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `collection/${encodeURIComponent(args.entry_id)}`, v(args.version)))),
  },
  {
    name: 'save_to_collection',
    description:
      'Save one of this site\'s block templates (kind "section" or "block_template"; the template\'s own kind decides which), page templates, free global blocks or block types to the organization collection, with the styles, block types, global blocks and media it uses. Returns 201 { entry, warnings }. ' + WHO,
    inputSchema: {
      kind: z.enum(['section', 'block_template', 'page_template', 'global_block', 'block_type']),
      id: z.string().min(1).max(100).describe('The site\'s template, global block or block type id.'),
      name: z.string().max(120).optional(), description: z.string().max(500).optional(), category: z.string().max(60).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async ({ version, ...body }, { client, siteId }) => ok(await client.post(siteId, 'collection/save', body, v(version)))),
  },
  {
    name: 'add_package_to_collection',
    description:
      'Add a Typeroll package (.typeroll) to the organization collection without changing the site. A collection package becomes one entry per block template, page template, free global block and block type, each with what it depends on; a site package is kept whole as one entry of kind "package". Its menus, design, settings pages and font files are not entries. The source package, publisher and verified signature are recorded. Returns 201 { entries, warnings }.',
    inputSchema: {
      data_base64: z.string().optional().describe('The .typeroll file, base64-encoded (at most 32 MB). Send this or source_url.'),
      source_url: z.string().optional().describe('An https:// address to download the package from (up to 200 MB).'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'collection/import', Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))))),
  },
  {
    name: 'insert_from_collection',
    description:
      'Insert a collection entry into this site. target "library" adds the block template, page template, global block or block type (a built-in header or footer replaces the site\'s own; a whole package imports its content). target "page" places a section\'s, block template\'s or free global block\'s blocks in the page\'s draft: after after_block_id (in that block\'s parent or slot when it is nested), or at position (top level, or in parent_id / slot_index); at the end by default. Returns { report, page?: { id, added_ids, blocks } }; save the page to publish the change. ' + STYLES,
    inputSchema: {
      entry_id: entryId,
      target: z.enum(['library', 'page']).default('library'),
      page_id: z.string().optional().describe('Required for target "page".'),
      after_block_id: z.string().optional(),
      position: z.number().int().min(0).optional(),
      parent_id: z.string().nullable().optional(),
      slot_index: z.number().int().min(0).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async ({ entry_id, version, ...body }, { client, siteId }) => ok(await client.post(siteId, `collection/${encodeURIComponent(entry_id)}/insert`,
      Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)), v(version)))),
  },
  {
    name: 'update_collection_entry',
    description: 'Change a collection entry\'s name, description or category (an empty description or category removes it). Built-in entries are read-only.',
    inputSchema: { entry_id: entryId, name: z.string().max(120).optional(), description: z.string().max(500).optional(), category: z.string().max(60).optional() },
    handler: withErrorBoundary(async ({ entry_id, ...patch }, { client, siteId }) => ok(await client.patch(siteId, `collection/${encodeURIComponent(entry_id)}`,
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))))),
  },
  {
    name: 'delete_collection_entry',
    description: 'Remove an entry from the organization collection, and the stored files no other entry uses. Sites it was inserted into keep their copies. Built-in entries cannot be removed. Confirm with the user first.',
    inputSchema: { entry_id: entryId },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `collection/${encodeURIComponent(args.entry_id)}`))),
  },
];
