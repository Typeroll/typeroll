// Collections + items (blog, team, events, products, custom).

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const collectionTools: ToolDef[] = [
  {
    name: 'create_collection',
    description:
      'Create a new content collection with a field schema and (optionally) per-item URLs. Pass `route_template` (e.g. "/restaurants/{slug}") to give each published item its own URL — omit to default to "/{name}/{slug}", set to "" to disable per-item URLs entirely.',
    inputSchema: {
      name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
      label_singular: z.string().min(1),
      label_plural: z.string().min(1),
      icon: z.string().optional(),
      fields: z
        .array(
          z.object({
            name: z.string(),
            label: z.string(),
            type: z.string(),
            required: z.boolean().optional(),
            default: z.unknown().optional(),
            options: z.array(z.string()).optional(),
          }).passthrough(),
        )
        .min(1),
      slug_field: z.string().optional(),
      sort_field: z.string().optional(),
      sort_dir: z.enum(['asc', 'desc']).optional(),
      route_template: z.string().optional(),
      item_template_html: z.string().optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'collections', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'update_collection_schema',
    description:
      'PATCH a collection\'s schema or routing. Pass only the fields you want to change. Renaming a field would orphan existing item data — adding new fields is safe, removing fields is silently allowed but item docs keep the dropped data.',
    inputSchema: {
      name: z.string(),
      patch: z
        .object({
          label_singular: z.string().optional(),
          label_plural: z.string().optional(),
          icon: z.string().optional(),
          fields: z.array(z.record(z.unknown())).optional(),
          slug_field: z.string().optional(),
          sort_field: z.string().optional(),
          sort_dir: z.enum(['asc', 'desc']).optional(),
          route_template: z.string().optional(),
          item_template_html: z.string().optional(),
          schema_type: z
            .string()
            .optional()
            .describe('Free-form Schema.org type for auto JSON-LD on every item route ("BlogPosting", "PodcastEpisode", "Product", "Event", "Recipe", "Course", …). Pair with schema_field_map when item field names differ from the schema property names.'),
          schema_field_map: z
            .record(z.string())
            .optional()
            .describe('Override the default field→schema-property mapping. Example: { "audio_url": "contentUrl", "show_notes": "description" }. Values use camelCase (Schema.org convention).'),
        })
        .passthrough(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.patch(
        siteId,
        `collections/${encodeURIComponent(args.name)}`,
        args.patch,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_collection',
    description:
      'Delete a collection AND every item in it. Destructive; requires `confirm: true`. Get-the-user-to-confirm workflow recommended.',
    inputSchema: {
      name: z.string(),
      confirm: z.literal(true).describe('Must be true to actually delete.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `collections/${encodeURIComponent(args.name)}`,
        { confirm: 'true', ...v(args.version) },
      );
      return ok(res);
    }),
  },
  {
    name: 'list_collections',
    description: 'List content collections on the site (name, label, icon, field schemas).',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'collections', v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'read_collection',
    description: 'Fetch one collection\'s schema (label, fields, icon).',
    inputSchema: { name: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `collections/${encodeURIComponent(args.name)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'collection_completeness',
    description:
      "Which records in a collection need work, worst first. Returns per-field gap counts across the whole collection plus the N worst items (missing fields, never-verified fields, and fields whose last write is older than the staleness window). Use this INSTEAD of paging every item and diffing client-side — it's the intended entry point for an enrichment pass. Computed at read time, so it's never stale. By default only fields an API key may actually write are counted, since a gap you're forbidden to close is noise; pass all_fields: true for a human audit.",
    inputSchema: {
      collection: z.string(),
      limit: z.number().int().min(1).max(500).optional().describe('Worst-N items to return. Default 50.'),
      stale_after_days: z.number().int().min(1).optional().describe('A field untouched for longer than this is reported stale. Default 180.'),
      all_fields: z.boolean().optional().describe('Include fields no API key may write. Default false.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { collection, version, ...query } = args;
      const res = await client.get(
        siteId,
        `collections/${encodeURIComponent(collection)}/completeness`,
        { ...query, ...v(version) },
      );
      return ok(res);
    }),
  },
  {
    name: 'list_collection_items',
    description:
      'List items in a collection with status filter + cursor pagination (cap 200 per page). Defaults to summary mode (richtext/textarea fields replaced with a byte-count hint) so a 200-item directory listing stays compact; pass include_richtext: true if you actually need full bodies.',
    inputSchema: {
      collection: z.string(),
      status: z.enum(['draft', 'published', 'all']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      include_richtext: z.boolean().optional().describe('Include full richtext/textarea field values inline. Default false.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { collection, version, include_richtext, ...query } = args;
      const res = await client.get(
        siteId,
        `collections/${encodeURIComponent(collection)}/items`,
        { ...query, ...(include_richtext ? {} : { summary: 'true' }), ...v(version) },
      );
      return ok(res);
    }),
  },
  {
    name: 'batch_read_collection_items',
    description: 'Read up to 200 collection items in one call. Returns per-id found/not-found.',
    inputSchema: {
      collection: z.string(),
      item_ids: z.array(z.string()).min(1).max(200),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `collections/${encodeURIComponent(args.collection)}/items/batch-read`,
        { item_ids: args.item_ids },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'read_collection_item',
    description: 'Fetch a single item with all fields.',
    inputSchema: { collection: z.string(), item_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `collections/${encodeURIComponent(args.collection)}/items/${encodeURIComponent(args.item_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'create_collection_item',
    description:
      'Create an item. Fields outside the collection schema are silently dropped — call list_collections first if you\'re unsure what fields exist.',
    inputSchema: {
      collection: z.string(),
      fields: z.record(z.unknown()),
      status: z.enum(['draft', 'published']).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { collection, version, ...body } = args;
      const res = await client.post(
        siteId,
        `collections/${encodeURIComponent(collection)}/items`,
        body,
        v(version),
      );
      return ok(res);
    }),
  },
  {
    name: 'update_collection_item',
    description: 'Update a collection item. Fields outside the schema are dropped. BUFFER MODEL: field values land in the item\'s unsaved DRAFT (status applies immediately); pass save:true to commit in the same call, or commit_working_copy later. Scheduled publishing (0.29.0+): pass publish_at/unpublish_at INSIDE `fields` — ISO datetime at which the platform flips status (+ deploys the site); null clears; applies immediately like status.',
    inputSchema: {
      collection: z.string(),
      item_id: z.string(),
      fields: z.record(z.unknown()).optional(),
      status: z.enum(['draft', 'published']).optional(),
      save: z.boolean().optional().describe('Also SAVE (commit) the draft in the same call.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { collection, item_id, version, ...body } = args;
      const res = await client.patch(
        siteId,
        `collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(item_id)}`,
        body,
        v(version),
      );
      return ok(res);
    }),
  },
  {
    name: 'regenerate_collection_listing',
    description:
      'Refresh a hand-managed listing of collection items on a page. The agent inserts a marker pair `<!-- typeroll:listing:{collection} -->` ... `<!-- /typeroll:listing:{collection} -->` into a page body once; from then on this tool fills the section between the markers with the current published items, sorted by the collection\'s sort_field. Pass `item_template` to customize per-item HTML — {{field}} substitutes HTML-escaped, {{{field}}} raw, {{url}} resolves through the collection\'s route_template. Defaults to a basic <ul> of links.',
    inputSchema: {
      collection: z.string(),
      page_id: z.string(),
      item_template: z.string().optional()
        .describe('Per-item HTML template. Default: <li><a href="{{url}}">{{title}}</a></li>'),
      wrap_open: z.string().optional().describe('Override the opening wrap element. Default: <ul class="tr-listing">'),
      wrap_close: z.string().optional().describe('Override the closing wrap element. Default: </ul>'),
      empty_html: z.string().optional().describe('Rendered when no items exist.'),
      sort_field: z.string().optional().describe('Override the collection\'s default sort_field.'),
      sort_dir: z.enum(['asc', 'desc']).optional(),
      status_filter: z.enum(['published', 'all']).optional().describe('Default: published.'),
      limit: z.number().int().min(1).max(500).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { collection, version, ...body } = args;
      const res = await client.post(
        siteId,
        `collections/${encodeURIComponent(collection)}/regenerate-listing`,
        body,
        v(version),
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_collection_item',
    description: 'Delete a collection item.',
    inputSchema: { collection: z.string(), item_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `collections/${encodeURIComponent(args.collection)}/items/${encodeURIComponent(args.item_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
];
