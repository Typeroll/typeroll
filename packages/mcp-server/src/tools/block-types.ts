// Block-type tools. Surface is wired in now so the future block editor
// drops in without breaking integrations.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

// The per-block markup. These three fields dominate the payload size (a few
// dozen blocks of template HTML + scoped CSS can exceed an agent's token
// budget and get truncated), and an agent enumerating the library rarely
// needs them — read_block_type fetches them for one block on demand. So
// list_block_types omits them by default and returns a lightweight summary.
const HEAVY_BLOCK_TYPE_FIELDS = ['template', 'styles', 'script'] as const;

/** Strip the heavy markup fields from each block type in a `block-types`
 *  response, preserving the field `schema` and all light metadata. Defensive:
 *  if the shape isn't the expected `{ block_types: [...] }`, pass it through. */
function summariseBlockTypes(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res;
  const envelope = res as Record<string, unknown>;
  const list = envelope.block_types;
  if (!Array.isArray(list)) return res;
  const slim = list.map((bt) => {
    if (!bt || typeof bt !== 'object') return bt;
    const copy = { ...(bt as Record<string, unknown>) };
    for (const field of HEAVY_BLOCK_TYPE_FIELDS) delete copy[field];
    return copy;
  });
  return { ...envelope, block_types: slim };
}

export const blockTypeTools: ToolDef[] = [
  {
    name: 'export_block_types',
    description:
      'Pack custom block types into a .tcblocks zip (base64). When `ids` is omitted, every user-created block type is bundled. Useful for moving blocks between sites or backing them up — the returned zip is a portable package the import tool reads back.',
    inputSchema: {
      ids: z.array(z.string()).optional().describe('Specific block-type ids to include. Omit to export every user-created block.'),
      name: z.string().optional().describe('Package name (default: {site}-blocks).'),
      version: z.string().optional().describe('Package version (default: 1.0.0).'),
      version_branch: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = {};
      if (args.ids?.length) query.ids = args.ids.join(',');
      if (args.name) query.name = args.name;
      if (args.version) query.version = args.version;
      if (args.version_branch) query.version = args.version_branch;
      const res = await client.get(siteId, 'blocks/export', query);
      return ok(res);
    }),
  },
  {
    name: 'import_block_types',
    description:
      'Install block types from a .tcblocks package. Provide the zip as base64. Re-importing the same package overwrites existing blocks with the same id (package_name/block_name). Each imported BlockType may include arbitrary CSS and JS — the caller is responsible for trusting the source. Returns counts of created vs updated docs.',
    inputSchema: {
      zip_base64: z.string().describe('Base64-encoded .tcblocks zip.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const v = args.version ? { version: args.version } : undefined;
      const res = await client.post(siteId, 'blocks/import', { zip_base64: args.zip_base64 }, v);
      return ok(res);
    }),
  },
  {
    name: 'list_block_types',
    description:
      'Discover every block type usable on this site. Returns ALL of them in one list: core blocks (id like "core/section", always available), custom blocks (origin: "user", created in the portal), and third-party blocks (origin: "third_party", imported from .tcblocks packages). Call this FIRST when starting block-mode work — never hardcode block ids; the available set is per-site. By default this is a LIGHTWEIGHT SUMMARY: each entry has id, label, category, icon, container/slot info, origin, and the full field schema (name/type/label/required/options/default) — everything you need to pick a block and call add_block — but NOT the render-time markup. The per-block template HTML, scoped styles, and script are omitted so the list stays within token budget no matter how large the library grows; fetch them for a single block with read_block_type, or pass full:true to inline them for every block (can be very large).',
    inputSchema: {
      include_core: z.boolean().optional().describe('Default true. Set false to get only custom + third-party (rarely needed).'),
      full: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, include each block type's template HTML, styles CSS, and script inline — the full doc. Large; prefer read_block_type for one block's markup.",
        ),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = {};
      if (args.version) query.version = args.version;
      if (args.include_core === false) query.include_core = 'false';
      const res = await client.get(siteId, 'block-types', query);
      return ok(args.full ? res : summariseBlockTypes(res));
    }),
  },
  {
    name: 'read_block_type',
    description:
      "Full schema for one block type. Returns the BlockType doc with template, styles, optional script, and the field-definitions array. Use this when list_block_types' summary isn't enough — e.g. before add_block on a custom block whose data fields you haven't seen.",
    inputSchema: {
      type_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `block-types/${encodeURIComponent(args.type_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'find_pages_using_block_type',
    description:
      'Pages whose block tree contains this block type. Empty for HTML-mode sites (the default today); fills in once block-mode pages exist.',
    inputSchema: {
      type_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `block-types/${encodeURIComponent(args.type_id)}/usage`,
        v(args.version),
      );
      return ok(res);
    }),
  },

  // ─── BlockType authoring — CREATE / UPDATE / DELETE ──────────────────
  // `script` runs with full DOM access in every visitor's browser. Through
  // an API key it is ACCEPTED under the key holder's authority (same trust
  // level as scripts_head) — the write is audit-logged and the response
  // carries a notice naming the stored JS. Only the in-portal chat AI
  // remains gated on Site.ai_scripts_enabled. Origin is stamped 'ai' so
  // audit + UI distinguish agent-authored types.

  {
    name: 'create_block_type',
    description:
      "Create a new custom block type usable on this site. Origin is stamped 'ai' automatically. The block ships immediately to every page editor + the renderer's registry. Custom JS via `script` is accepted under your API key's authority (audit-logged; the response carries a notice) — review before deploy. This is the supported way to ship per-page JS: `<script>` written into page or block MARKUP is stripped by the renderer's sanitizer no matter which credential wrote it, so package the behaviour as a block type instead. Site-wide tags belong in settings.scripts_head / scripts_body_end. Returns the created BlockType. Responsive fields: mark a schema field `responsive: true` and expose it as style=\"--{field}:{{field}}\" on the outermost element so it can vary per breakpoint. If the value is directly usable CSS, read var(--{field}); if it's a token that maps to CSS (e.g. layout 'icon-left' → flex-direction:row) add a `responsive_css` map on the field ({ 'icon-left': '--dir: row;' }), otherwise per-breakpoint overrides won't take effect.",
    inputSchema: {
      name: z.string().describe('Machine name (lowercase kebab/underscore, 1-64 chars). Becomes the id.'),
      label: z.string().optional().describe('Display label (defaults to name).'),
      icon: z.string().optional().describe('Lucide icon name shown in the block picker.'),
      category: z.enum(['layout', 'content', 'media', 'custom']).optional(),
      container: z.union([
        z.literal(true), z.literal(false),
        z.enum(['slots', 'repeater', 'conditional']),
      ]).optional().describe('Container kind. Use slots for fixed named slots, repeater for looping over items, conditional for show-if blocks.'),
      slot_count: z.number().optional().describe('Required when container="slots". 1-8.'),
      slot_labels: z.array(z.string()).optional(),
      item_compatible: z.boolean().optional().describe('Mark true if this block is designed to render as a repeater item (no outer padding, kernel layout).'),
      expand_to: z.object({
        target: z.string(),
        defaults: z.record(z.unknown()),
      }).optional().describe('Alias mechanism — render as another block type with these defaults merged under authored data.'),
      schema: z.array(z.unknown()).optional().describe('FieldDefinition[]. Each field has name, type, label, optional required/default/options/responsive.'),
      template: z.string().optional().describe('HTML with {{field}}, {{{field}}}, {{=tag}}, {{children}}, {{slot:NAME}} substitutions.'),
      styles: z.string().optional().describe('Block-scoped CSS. Selectors should start with [data-block="<name>"].'),
      script: z.string().optional().describe("Client-side JS shipped with the block (runs on the published site). Accepted under your API key's authority — the write is audit-logged and the response carries a notice naming the stored JS. It runs on the published site's own origin, which shares nothing with the Typeroll portal."),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      // origin=ai is set via query so the API route can stamp it server-side
      const query: Record<string, string | undefined> = { origin: 'ai' };
      if (version) query.version = version;
      const res = await client.post(siteId, 'block-types', body, query);
      return ok(res);
    }),
  },
  {
    name: 'update_block_type',
    description:
      "Update fields of an existing custom block type. Core blocks (id starts with 'core/') are read-only — they're managed in platform code. Schema/template/styles replace wholesale (no deep merge); other fields shallow-merge. The `script` field follows the same policy as create_block_type — accepted under your key's authority, audit-logged, notice in the response.",
    inputSchema: {
      type_id: z.string().describe('Block type id (custom or third_party). Cannot be a core/* block.'),
      label: z.string().optional(),
      icon: z.string().optional(),
      category: z.enum(['layout', 'content', 'media', 'custom']).optional(),
      container: z.union([
        z.literal(true), z.literal(false),
        z.enum(['slots', 'repeater', 'conditional']),
      ]).optional(),
      slot_count: z.number().optional(),
      slot_labels: z.array(z.string()).optional(),
      item_compatible: z.boolean().optional(),
      expand_to: z.object({ target: z.string(), defaults: z.record(z.unknown()) }).optional(),
      schema: z.array(z.unknown()).optional(),
      template: z.string().optional(),
      styles: z.string().optional(),
      script: z.string().optional().describe("Accepted under your API key's authority; audit-logged, and the response carries a notice naming the stored JS."),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { type_id, version, ...body } = args;
      const res = await client.patch(
        siteId,
        `block-types/${encodeURIComponent(type_id)}`,
        body,
        v(version),
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_block_type',
    description:
      "Remove a custom block type. Core blocks (core/*) cannot be deleted. **Warning**: pages currently using this block type will render '<!-- unknown block type -->' comments instead. Call find_pages_using_block_type FIRST to see the blast radius; the AI should prompt the user before deleting if usage > 0.",
    inputSchema: {
      type_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `block-types/${encodeURIComponent(args.type_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
];
