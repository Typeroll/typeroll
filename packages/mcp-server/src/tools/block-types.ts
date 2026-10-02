// Block-type tools: discovery, authoring (validate, preview, create, update,
// delete), usage, starters and .tcblocks packages. Every write goes through
// the portal's one block type write path (shared validator, version chain,
// rename migration), and authoring needs admin permission on the Site.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

// The per-block markup. These fields dominate the payload size (a few dozen
// blocks of template HTML + scoped CSS can exceed an agent's token budget and
// get truncated), and an agent enumerating the library rarely needs them —
// read_block_type fetches them for one block on demand. So list_block_types
// omits them by default and returns a lightweight summary.
const HEAVY_BLOCK_TYPE_FIELDS = ['template', 'styles', 'styles_compiled', 'script', 'composition'] as const;

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
    if (Array.isArray(copy.composition) && copy.composition.length) copy.composed = true;
    for (const field of HEAVY_BLOCK_TYPE_FIELDS) delete copy[field];
    return copy;
  });
  return { ...envelope, block_types: slim };
}

const AUTHORING_GUIDE =
  'Two kinds of site block type. COMPOSED (preferred): `composition` is a tree of existing blocks ({ id, type, data, children? } — core/heading, core/text, core/prose, core/image, core/icon, core/button, core/container, core/grid, core/repeater …) and `schema` declares the props people edit when they place the block. Inner blocks read props through exact bindings as the WHOLE value: a heading\'s text "{{props.title}}"; a core/repeater with items "{{props.items}}" (an array prop) renders its children once per item, where "{{item.title}}" reads the item and "{{item.link.href}}" a link sub-value. Everything the inner blocks do (named styles, responsive settings, images, safe links, render versions) carries over. ' +
  'TEMPLATE (advanced, when existing blocks cannot express the markup): `template` is HTML with {{field}} (escaped), {{{field}}} (raw: richtext fields and derived …_svg / …_html only), {{#field}}…{{/field}} (shown when set), {{^field}}…{{/field}} (shown when empty), {{#each items}}…{{/each}} (per array item; names resolve against the item first; {{@index}}, {{@number}}, {{@first}}, {{@last}}), {{#link field class="…"}}…{{/link}} (wraps the body in a safe <a href rel target> when the link resolves), plus {{children}} / {{slot:NAME}} for containers. ' +
  'Fields: text, textarea, richtext, image, icon (derived {name}_svg), select (options), boolean, number, url, link ({ page_id?, url?, new_tab? } — prefer page_id for a page on the Site, it survives slug changes; resolves to .href, .target, .rel), array (a repeating group: fields, item_label, min_items, max_items; nests 3 levels), object, style … each with name, type, label and optional help, required, default. ' +
  '`styles` is scoped to the block when written: every selector applies inside [data-block="<name>"], :scope is the block element itself, body/html/:root are refused; use the site\'s var(--color-*) and spacing tokens. The response returns `styles_compiled`, the CSS that ships. ' +
  'Unknown properties are errors. Every problem has a JSON-pointer `path` (and a `line` for markup/CSS); a 400 lists them all in `problems`, warnings come back in `warnings`. Call validate_block_type / preview_block_type first, and list_block_type_starters for complete examples. Needs ADMIN permission on the Site; editors (write) place block types on pages and edit their fields.';

const definitionShape = {
  label: z.string().optional().describe('Display label in the block picker.'),
  description: z.string().optional().describe('When to use this block type; shown to editors and agents (≤ 500 chars).'),
  icon: z.string().optional().describe('Lucide icon name shown in the block picker.'),
  category: z.enum(['layout', 'content', 'media', 'custom']).optional(),
  container: z.union([
    z.literal(true), z.literal(false),
    z.enum(['slots', 'repeater', 'conditional']),
  ]).optional().describe('Template types only. true renders {{children}}, slots fixed named slots, repeater loops over items, conditional show-if. A composed type is never a container; put a container block inside its composition.'),
  slot_count: z.number().optional().describe('Required when container="slots". 1-8.'),
  slot_labels: z.array(z.string()).optional(),
  item_compatible: z.boolean().optional().describe('Mark true if this block is designed to render as a repeater item (no outer padding).'),
  expand_to: z.object({
    target: z.string(),
    defaults: z.record(z.unknown()),
  }).optional().describe('Alias mechanism — render as another block type with these defaults merged under authored data.'),
  schema: z.array(z.unknown()).optional().describe('FieldDefinition[]: { name, type, label, help?, required?, default?, options? (select), fields? (array/object), item_label?, min_items?, max_items? }. Replaces the whole schema on update.'),
  composition: z.array(z.unknown()).optional().describe('Block[] a composed type is built from. Bind data to props with "{{props.name}}" and, inside a core/repeater over an array prop, to items with "{{item.name}}" — always as the whole value.'),
  template: z.string().optional().describe('Markup of a template type (instead of composition); see the section syntax above.'),
  styles: z.string().optional().describe('CSS scoped to the block. Write selectors for the block\'s own markup; :scope is the block element.'),
  script: z.string().optional().describe("Client-side JS shipped with the block (runs on the published site's own origin). Accepted under your API key's authority — the write is audit-logged. Prefer a composed type without script."),
};

export const blockTypeTools: ToolDef[] = [
  {
    name: 'export_block_types',
    description:
      'Pack site block types into a .tcblocks zip (base64). When `ids` is omitted, every block type the Site has (made in the portal, by an agent, or imported) is bundled. The package keeps every property — composition, template, styles and CSS scope, script, field help and list settings — so it moves between any Sites, in any Organization or Typeroll instance. import_block_types reads it back.',
    inputSchema: {
      ids: z.array(z.string()).optional().describe('Specific block-type ids to include. Omit to export every site block type.'),
      name: z.string().optional().describe('Package name (default: {site}-blocks).'),
      version: z.string().optional().describe('Package version written into the manifest (default: 1.0.0). This is the package semver, not a Site version — use version_branch for that.'),
      version_branch: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = {};
      if (args.ids?.length) query.ids = args.ids.join(',');
      if (args.name) query.name = args.name;
      if (args.version) query.version = args.version;
      // Distinct parameters: `version` is the package semver, `version_branch`
      // selects the site version. Sending both on `version` made the branch
      // silently overwrite the package name.
      if (args.version_branch) query.version_branch = args.version_branch;
      const res = await client.get(siteId, 'blocks/export', query);
      return ok(res);
    }),
  },
  {
    name: 'import_block_types',
    description:
      'Install block types from a .tcblocks package (zip as base64). Needs ADMIN permission on the Site. Each definition is checked by the same validator as create_block_type; a definition with errors is reported as failed and not written. On a name conflict `on_conflict` decides: skip (default) keeps the Site\'s type, rename imports it under a free name (references inside the package follow), replace overwrites it. Returns `results` per type (created, renamed, replaced, skipped, failed with problems) and counts. Imported types may carry CSS and JS — only import packages you trust.',
    inputSchema: {
      zip_base64: z.string().describe('Base64-encoded .tcblocks zip.'),
      on_conflict: z.enum(['skip', 'rename', 'replace']).optional().describe('What to do when the Site already has a block type with the same name. Default skip.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'blocks/import', {
        zip_base64: args.zip_base64,
        ...(args.on_conflict ? { on_conflict: args.on_conflict } : {}),
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'list_block_types',
    description:
      'Discover every block type usable on this site. Returns ALL of them in one list: core blocks (id like "core/section", always available), site block types (origin "user" from the portal, "ai" from an agent) and third-party blocks (origin "third_party", imported from .tcblocks packages). Call this FIRST when starting block-mode work — never hardcode block ids; the available set is per-site. By default this is a LIGHTWEIGHT SUMMARY: id, label, description, category, icon, container/slot info, origin, `composed: true` for composed types, and the full field schema — everything you need to pick a block and call add_block — but NOT the template, composition, styles or script. Fetch those for one block with read_block_type, or pass full:true to inline them for every block (can be very large).',
    inputSchema: {
      include_core: z.boolean().optional().describe('Default true. Set false to get only the site\'s own and third-party types.'),
      full: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, include each block type's template, composition, styles and script inline — the full doc. Large; prefer read_block_type for one block.",
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
      "Full definition of one block type: the field schema, and its composition (composed types) or template (template types), styles with `styles_compiled` (the scoped CSS that ships), and optional script. Use this when list_block_types' summary isn't enough — before add_block on an unfamiliar block, or before update_block_type.",
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
      'Everything that uses a block type, on every surface: `pages` (saved block pages and drafts — `sources` says which), `templates` (page templates), `partials` (header, footer, global blocks), `block_templates`, and `block_types` (other site block types built from it). Repeaters that render the type as their item_block count, and a use through another block type names it in `via`. `total` sums the lists; delete_block_type is refused while it is above zero. Call it before changing or removing fields of a type in use.',
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
  {
    name: 'list_block_type_starters',
    description:
      'Built-in starting points for a new block type: complete composed definitions (icon list, feature cards, numbered steps) with fields, composition and scoped CSS. Adapt one (rename it, change fields) and pass it to create_block_type — it is the quickest way to a valid composed type.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'block-types/starters');
      return ok(res);
    }),
  },
  {
    name: 'validate_block_type',
    description:
      `Check a block type definition without saving it, with the exact validator create_block_type and update_block_type use. Pass the whole definition, or with type_id a patch to that stored type (renames are checked too). Returns { ok, problems, merged }: every error and warning with a JSON-pointer path (e.g. /schema/0/fields/2/name, /composition/0/children/1/data/text) and a line for markup and CSS, and the definition as it would be stored. Writes nothing. ${AUTHORING_GUIDE}`,
    inputSchema: {
      definition: z.record(z.unknown()).describe('The block type definition (as for create_block_type), or a patch when type_id is set.'),
      type_id: z.string().optional().describe('Validate `definition` as a patch to this stored block type.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = {};
      if (args.type_id) query.type_id = args.type_id;
      if (args.version) query.version = args.version;
      const res = await client.post(siteId, 'block-types/validate', args.definition, query);
      return ok(res);
    }),
  },
  {
    name: 'preview_block_type',
    description:
      'Render a block type definition that need not be saved, through the same preview renderer as the portal (the Site\'s render version, theme CSS, named styles, custom CSS, the other site block types, and the sanitizer). Without `data` the block shows sample values derived from its fields. Returns { ok, html, css, document, data, problems }: `html` is the block\'s markup as a page carries it, `css` the scoped block CSS that ships, `document` a standalone HTML page. A definition with errors is not rendered (ok:false, problems listed). Block scripts never run in a preview. Writes nothing.',
    inputSchema: {
      definition: z.record(z.unknown()).optional().describe('The block type definition, or a patch when type_id is set. Omit with type_id to preview the stored type.'),
      type_id: z.string().optional().describe('Preview `definition` as a patch to this stored block type.'),
      data: z.record(z.unknown()).optional().describe('Field values for the previewed block. Omit for sample data.'),
      render_version: z.number().int().optional().describe('Render with this platform render version instead of the Site\'s own.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'block-types/preview', { ...body, definition: body.definition ?? {} }, v(version));
      return ok(res);
    }),
  },

  // ─── BlockType authoring — CREATE / UPDATE / DELETE ──────────────────
  // Admin permission on the Site, as in the portal. `script` runs with full
  // DOM access in every visitor's browser. Through an API key it is ACCEPTED
  // under the key holder's authority (same trust level as scripts_head) and
  // the write is audit-logged. Only the in-portal chat never writes it.
  // Origin is stamped 'ai' so audit + UI distinguish agent-authored types.

  {
    name: 'create_block_type',
    description:
      `Create a block type for this Site when no core block (or block template) fits a recurring shape. Origin is stamped 'ai'; id = name. The type is available to every page editor immediately and reaches the live site with the next deploy. ${AUTHORING_GUIDE} Returns { block_type, warnings }; 409 when the name exists. A block type is the supported way to ship per-block JS (\`script\`): <script> written into page or block markup is always stripped by the sanitizer. Site-wide tags belong in settings.scripts_head / scripts_body_end.`,
    inputSchema: {
      name: z.string().describe('Machine name (lowercase letters, digits, "-" and "_", 1-64 chars). Becomes the id.'),
      ...definitionShape,
      label: z.string().describe('Display label in the block picker.'),
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
      "Change a site block type (core/* types are read-only). Needs ADMIN permission. schema, composition, template and styles replace wholesale when sent; other properties merge. Changing a type in use: to RENAME a field, send the new schema with `renames` ({ \"title\": \"heading\", \"items.label\": \"text\" } — dotted paths of the OLD names, new name of the field) and the data moves in every block that uses the type (saved pages and drafts, page templates, header/footer/global blocks, block templates, other block types, repeater items), after a revision of each changed page; a composed type's own {{props.…}}/{{item.…}} bindings follow unless you send a composition. Removing or retyping a field that holds data answers 409 with the affected uses until you resend with confirm_data_loss: true (ask the user first). Returns { block_type, warnings, impact: { usages, renamed, removed, retyped } }. The same validation as create_block_type applies.",
    inputSchema: {
      type_id: z.string().describe('Block type id (a site type). Cannot be a core/* block.'),
      ...definitionShape,
      renames: z.record(z.string()).optional().describe('Old field path → new field name, e.g. { "title": "heading", "items.label": "text" }. Send together with the new schema.'),
      confirm_data_loss: z.boolean().optional().describe('Drop the data of removed or retyped fields that hold data. Only after the user agreed; the 409 lists what would be lost.'),
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
      "Remove a site block type. Needs ADMIN permission; core blocks (core/*) cannot be deleted. Refused with 409 while anything uses the type — pages and drafts, page templates, header, footer, global blocks, block templates, other block types or repeaters — and the refusal lists the uses (as find_pages_using_block_type does). Remove those uses first and confirm with the user.",
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
