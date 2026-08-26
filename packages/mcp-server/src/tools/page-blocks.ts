// Page-block mutation tools. Five primitives (get/add/update/move/remove)
// plus a one-shot HTML→blocks converter. All target the active version
// (override with `version`).
//
// The AI agent uses these to author block-mode pages directly. For
// HTML-mode pages, `convert_page_to_blocks` is the bridge — call with
// `dry_run: true` first to preview, then `dry_run: false, switch_mode:
// true` to commit.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

const blockSchema = z.object({
  id: z.string().optional().describe('Stable id. Omit to let the server generate one.'),
  type: z.string().describe('Block type id, e.g. "core/heading", "core/section", or a custom "user/banner".'),
  data: z.record(z.unknown()).optional().describe('Field values matching the block-type schema.'),
  children: z.array(z.any()).optional().describe('Nested blocks for container types.'),
  slots: z.array(z.array(z.any())).optional().describe('Slot contents for slot-container types.'),
  style_overrides: z.object({
    spacing_before: z.string().optional(),
    spacing_after: z.string().optional(),
    custom_css: z.string().optional(),
    custom_class: z.string().optional(),
    html_id: z.string().optional(),
  }).optional(),
}).passthrough();

/**
 * Generic container target. kind=page is the back-compat default — when
 * `page_id` is provided without `target`, the dispatcher synthesises
 * `{ kind: 'page', id: page_id }`.
 */
const targetSchema = z.object({
  kind: z.enum(['page', 'partial', 'template', 'item_template']),
  id: z.string(),
}).describe('Address a container. kind=page|partial|template|item_template. Pages: id is the page id. Partials: id is "header"|"footer"|<free-block id>. Templates: id is the PageTemplate id. item_template: id is the COLLECTION NAME — the block tree is the collection\'s per-item layout (e.g. blog post body bound to {{item.title}}, {{item.body}}, etc.).');

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}


/**
 * Resolve a (target | page_id) pair to a REST path prefix. Pages keep
 * routing through /pages/{id}/blocks for back-compat with older callers;
 * partials and templates route through /containers/{kind}/{id}/blocks
 * (the unified handler).
 */
function pathFor(target: { kind: string; id: string } | undefined, pageId: string | undefined): string {
  const kind = target?.kind ?? 'page';
  const id = target?.id ?? pageId;
  if (!id) throw new Error('Either target or page_id is required');
  if (kind === 'page') {
    return `pages/${encodeURIComponent(id)}/blocks`;
  }
  return `containers/${kind}/${encodeURIComponent(id)}/blocks`;
}

export const pageBlockTools: ToolDef[] = [
  {
    name: 'get_page_blocks',
    description:
      'Read the block tree of a container (page, partial, or page template). Use `target: { kind, id }` for partials/templates. For pages, `page_id` is the back-compat shorthand. Returns the DRAFT VIEW — the tree with any unsaved edits (yours or the editor\'s) included, i.e. exactly what the next mutation operates on. Empty array for HTML-mode pages. Always call this before any block mutation so you know what you\'re modifying.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional().describe('Shorthand for target={kind:"page", id:page_id}.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.get(siteId, path, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'add_block',
    description:
      'Insert a block into a container (page, partial, or page template). BUFFER MODEL: block mutations on pages/partials edit the unsaved DRAFT — commit_working_copy is the explicit save. With no parent_id, inserts at the top level of the container. Otherwise inserts as a child (or into a slot for slot-containers). Position defaults to "end". Slot containers (core/columns, core/tabs — container: "slots"): slot_index picks the slot (0-based; defaults to 0) and works even if the parent instance has no slots array yet; a freshly added slot container gets its slots initialised to the type\'s arity. You can also pass the whole subtree inline via block.slots: [[...],[...]]. Pass `target: { kind: "partial", id: "header" }` to drop a block into the header on every page, etc. `page_id` is the legacy shorthand.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block: blockSchema,
      parent_id: z.string().optional().nullable(),
      slot_index: z.number().int().min(0).optional(),
      position: z.number().int().min(0).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.post(siteId, path, {
        block: args.block,
        parent_id: args.parent_id,
        slot_index: args.slot_index,
        position: args.position,
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'update_block',
    description:
      'Update a block\'s data fields (shallow merge), style overrides, or responsive settings. Works on pages, partials, and page templates — use `target` to address non-page containers. Does not modify children or slots; use move/add/remove for structural changes.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block_id: z.string(),
      data: z.record(z.unknown()).optional(),
      style_overrides: z.object({
        spacing_before: z.string().optional(),
        spacing_after: z.string().optional(),
        custom_css: z.string().optional(),
        custom_class: z.string().optional(),
        html_id: z.string().optional(),
      }).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.patch(siteId, path, {
        block_id: args.block_id,
        data: args.data,
        style_overrides: args.style_overrides,
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'move_block',
    description:
      'Reparent or reorder a block inside its container. target_parent_id=null moves to top level. For slot containers, target_slot_index picks the slot. Cycles (moving a block into its own descendant) are rejected. Works for pages, partials, and templates.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block_id: z.string(),
      target_parent_id: z.string().optional().nullable(),
      target_slot_index: z.number().int().min(0).optional(),
      target_position: z.number().int().min(0).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.put(siteId, path, {
        block_id: args.block_id,
        target_parent_id: args.target_parent_id,
        target_slot_index: args.target_slot_index,
        target_position: args.target_position,
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'remove_block',
    description:
      'Remove a block and everything inside it from its container. Works for pages, partials, and templates.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const query: Record<string, string | undefined> = { block_id: args.block_id };
      if (args.version) query.version = args.version;
      const res = await client.del(siteId, path, query);
      return ok(res);
    }),
  },
  {
    name: 'duplicate_block',
    description:
      'Clone a block (subtree included) and insert the copy directly after the original within the same container. Returns the duplicate\'s new id. Useful for "add another card to this feature grid" — duplicate the existing one and then `update_block` on the new id to change its data. Works for pages, partials, and templates.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.post(siteId, `${path}/duplicate`, {
        block_id: args.block_id,
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'set_block_responsive',
    description:
      'Set a per-breakpoint value on one responsive field of a block (in any container — page, partial, or template). The renderer reads { mobile, tablet, laptop, desktop, wide } objects on any field marked responsive in the BlockType schema (use read_block_type to see which). Mobile-first inheritance: missing breakpoints inherit upward. Pass a scalar value to clear responsive back to a single value. Example: setting `cols` on a feature_grid to { mobile: 1, tablet: 2, desktop: 3 } renders 1-col on phones, 2-col on tablets, 3-col on desktop+.',
    inputSchema: {
      target: targetSchema.optional(),
      page_id: z.string().optional(),
      block_id: z.string(),
      field: z.string().describe('Field name (must be marked responsive in the BlockType schema).'),
      value: z.any().describe('Scalar (applies to all BPs) or { mobile?, tablet?, laptop?, desktop?, wide? }.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const path = pathFor(args.target, args.page_id);
      const res = await client.post(siteId, `${path}/responsive`, {
        block_id: args.block_id, field: args.field, value: args.value,
      }, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'set_page_mode',
    description:
      'Safely switch a page\'s content_mode between "blocks" and "html". Always snapshots a revision before the flip so the previous state is restorable. HTML → blocks with `convert: true` also runs the heuristic converter so the page starts with a populated tree. Blocks → HTML drops the block tree (the revision retains it). Prefer this over `update_page patch={content_mode}` because that bypasses snapshotting.',
    inputSchema: {
      page_id: z.string(),
      to: z.enum(['blocks', 'html']).describe('Target mode.'),
      convert: z.boolean().optional().describe('When going to blocks: run the htmlToBlocks heuristic on html_content. Ignored for blocks → html.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/mode`,
        { to: args.to, convert: args.convert ?? false },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'convert_page_to_blocks',
    description:
      'Heuristically convert a page\'s html_content into a block tree. By default runs as dry_run and returns the proposed blocks without writing. Pass dry_run: false to apply, and switch_mode: true to flip content_mode to "blocks" so the renderer uses the new tree. For a safer one-call switch with revision snapshot, use `set_page_mode` with `convert: true` instead.',
    inputSchema: {
      page_id: z.string(),
      dry_run: z.boolean().optional().describe('Default true. When true, returns the proposed tree without writing.'),
      switch_mode: z.boolean().optional().describe('When applying (dry_run=false), flip content_mode to "blocks". Default false.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/blocks/convert`,
        {
          dry_run: args.dry_run ?? true,
          switch_mode: args.switch_mode ?? false,
        },
        v(args.version),
      );
      return ok(res);
    }),
  },
];
