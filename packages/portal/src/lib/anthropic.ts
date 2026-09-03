// Anthropic client + the AI chat tool loop that powers /api/sites/[siteId]/chat.
//
// The chat lets the user manage the whole site by describing changes in plain
// English. Claude has tools for every meaningful surface — pages, partials
// (header/footer/nav), site settings, content collections, media, and
// redirects — and the system prompt teaches it the conventions of the
// platform (HTML mode, CSS variables, status flow, listing patterns).

import './load-env';
import Anthropic from '@anthropic-ai/sdk';
import { vstore } from './version-store';
import { getStore } from './datastore';
import { getBlockUsage, getAllBlockUsage } from './partials-usage';
import { DESIGN_NOTES_STARTER } from './design-notes';
import { PLAYBOOK_STARTER } from './playbook';
import { pageLiveUrl, pagePreviewUrl } from './site-urls';
import { checkRedirectWrite, redirectDocId } from './redirect-write';
import { paths, slugify } from '@typeroll/shared';
import type { Block, BlockType } from '@typeroll/shared';
import { CORE_BLOCK_TYPES } from '@typeroll/shared';
import {
  addBlock as addBlockMutation,
  updateBlock as updateBlockMutation,
  moveBlock as moveBlockMutation,
  removeBlock as removeBlockMutation,
  duplicateBlock as duplicateBlockMutation,
  setBlockResponsiveField,
  findBlock,
  BlockMutationError,
} from './block-mutations';
import {
  normaliseTarget,
  loadContainer,
  writeContainer,
  targetLabel,
  ContainerError,
  type BlockContainerTarget,
} from './block-containers';
import { htmlToBlocks } from './html-to-blocks';
import { snapshotRevision } from './revisions';
import { applyContentWrite } from './content-write';
import {
  commitWorkingCopy,
  discardWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  WorkingCopyError,
  type WcTarget,
} from './working-copy';
import type {
  CollectionDef,
  CollectionItem,
  Media,
  Page,
  Partial as PartialDoc,
  Redirect,
  Site,
  SiteSettings,
  SiteVersion,
} from '@typeroll/shared';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 12;

export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAction {
  type: string;
  description: string;
  target?: string;
  preview_url?: string;
}

export interface ChatToolCallLog {
  name: string;
  input_preview: string;
  ok: boolean;
  result_preview: string;
  error?: string;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
  tool_calls: ChatToolCallLog[];
  iterations: number;
}

const TOOL_PREVIEW_MAX = 400;

function previewJson(value: unknown, max = TOOL_PREVIEW_MAX): string {
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}… (+${str.length - max})` : str;
}

export async function getAnthropic(_orgId: string): Promise<Anthropic | null> {
  // TODO: load org-level BYOT key from organizations/{orgId} before falling
  // back to the platform default. For now, only the platform default.
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// ─── Tools ───────────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  // Pages
  {
    name: 'list_pages',
    description: 'List all pages with id, title, slug, content_mode, and status. Use this first when the user refers to a page by name.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_page',
    description: 'Read a full page including its HTML body, SEO fields, and status.',
    input_schema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
    },
  },
  {
    name: 'update_page_html',
    description:
      'Update the full HTML body of an existing HTML-mode page. Always provide the entire new body — never a diff. Preserve unrelated content unless the user asked to change it.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        html_content: { type: 'string', description: 'Full new HTML body for the page (no <html>/<body> wrapper).' },
      },
      required: ['page_id', 'html_content'],
    },
  },
  {
    name: 'update_page_seo',
    description: 'Update SEO fields on a page. Use `schema_type` for auto JSON-LD ("Service", "Product", "Course", …) and the nested `service` object when schema_type="Service".',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        seo_title: { type: 'string' },
        append_seo_suffix: { type: 'boolean', description: 'Set false to omit the site default SEO suffix on this page.' },
        seo_description: { type: 'string' },
        og_image: { type: 'string' },
        seo_image_alt: { type: 'string', description: 'Alt text for og:image / twitter:image. Falls back to first <img alt> on the page when unset.' },
        canonical_url: { type: 'string' },
        noindex: { type: 'boolean' },
        lastmod_override: { type: 'string', description: 'Override sitemap <lastmod>. Empty string suppresses lastmod entirely.' },
        schema_type: { type: 'string', description: 'Free-form Schema.org type ("Service", "Course", "Product", "FAQPage", …) for auto JSON-LD.' },
        service: {
          type: 'object',
          description: 'Service offer fields — only meaningful when schema_type="Service".',
          properties: {
            price: { type: ['number', 'string'] },
            price_currency: { type: 'string', description: 'ISO 4217 (SEK, EUR, USD).' },
            duration: { type: 'string' },
            description: { type: 'string' },
            url: { type: 'string' },
          },
        },
        kind: { type: 'string', enum: ['page', 'article'], description: 'Use "article" for blog posts; emits Article schema + og:type=article.' },
        author: { type: 'string', description: 'Author name for kind=article pages.' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'add_faq_schema',
    description: 'Attach FAQPage JSON-LD to a page. Use this when the page actually presents an FAQ — Google flags pages that emit FAQ schema for content that isn\'t.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              answer: { type: 'string' },
            },
            required: ['question', 'answer'],
          },
        },
      },
      required: ['page_id', 'items'],
    },
  },
  {
    name: 'add_recipe_schema',
    description: 'Attach Recipe JSON-LD to a recipe page. Required: name, recipeIngredient[], recipeInstructions[].',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        image_url: { type: 'string' },
        author: { type: 'string' },
        prep_time: { type: 'string', description: 'ISO 8601 duration, e.g. PT30M.' },
        cook_time: { type: 'string' },
        total_time: { type: 'string' },
        recipe_yield: { type: 'string', description: 'e.g. "4 servings".' },
        ingredients: { type: 'array', items: { type: 'string' } },
        instructions: { type: 'array', items: { type: 'string' } },
      },
      required: ['page_id', 'name', 'ingredients', 'instructions'],
    },
  },
  {
    name: 'add_event_schema',
    description: 'Attach Event JSON-LD to a page describing an upcoming event.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        start_date: { type: 'string', description: 'ISO 8601, e.g. 2026-06-12T19:00:00+02:00.' },
        end_date: { type: 'string' },
        location_name: { type: 'string' },
        location_address: { type: 'string' },
        image_url: { type: 'string' },
        offers_url: { type: 'string', description: 'Ticket URL.' },
        offers_price: { type: 'string' },
        offers_currency: { type: 'string', description: 'ISO 4217, e.g. EUR.' },
      },
      required: ['page_id', 'name', 'start_date'],
    },
  },
  {
    name: 'update_page_status',
    description: 'Change a page\'s status: draft | review | unlisted | published. Applies immediately (publish state is never drafted).',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'review', 'unlisted', 'published'] },
      },
      required: ['page_id', 'status'],
    },
  },
  {
    name: 'save_changes',
    description:
      'SAVE the unsaved draft (working copy) of a page, partial, or collection item — promotes your edits onto the saved doc with a revision snapshot. Your content edits are DRAFTS until saved: they show in the editor and draft previews but are excluded from deploys. Call this when the user approves the change or asks you to save/publish it. The user can also press Save in the editor themselves.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['page', 'partial', 'item'] },
        id: { type: 'string', description: 'Page id, partial id, or item id.' },
        collection: { type: 'string', description: 'Required when kind="item".' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'discard_changes',
    description:
      'Discard the unsaved draft (working copy) of a page, partial, or collection item — the saved doc is untouched. Use when the user rejects your proposed change. CAUTION: this also throws away any unsaved edits the user made in the editor on the same doc.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['page', 'partial', 'item'] },
        id: { type: 'string' },
        collection: { type: 'string', description: 'Required when kind="item".' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'create_page',
    description: 'Create a new HTML-mode page. Slug is derived from the title if not provided.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        slug: { type: 'string' },
        html_content: { type: 'string' },
        seo_title: { type: 'string' },
        seo_description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'review', 'unlisted', 'published'] },
      },
      required: ['title', 'html_content'],
    },
  },

  // ─── Block-mode pages (default for new pages since 2026-05) ──────────
  // Block schema is intentionally `passthrough` — the model can include
  // arbitrary data fields the block type's schema specifies. Container
  // blocks expose `children`; slot containers expose `slots`. The
  // server-side mutation handlers reject cycles and unknown parent ids.
  {
    name: 'get_page_blocks',
    description:
      "Read the block tree of a page, partial, or page template. With `page_id` (legacy shorthand) it returns either { content_mode: 'blocks', blocks } or { content_mode: 'html', html_content } depending on the page's mode. With `target: { kind: 'partial'|'template', id }` it returns the block tree of that container. Always call this first before mutating so you know what you're modifying.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Shorthand for target={kind:"page", id:page_id}.' },
        target: {
          type: 'object',
          description: 'Generic container. kind = page | partial | template. Use this to address a partial (e.g. {kind:"partial",id:"header"}) or template ({kind:"template",id:"blog-post"}).',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
      },
    },
  },
  {
    name: 'add_block',
    description:
      "Insert a block into a container — a page, partial, or page template. With no parent_id, inserts at the top level of the container. Otherwise the new block becomes a child of parent_id (or lands in slot_index N for slot-containers). Use `target: {kind, id}` to address partials and templates; `page_id` is the legacy shorthand for `target={kind:'page',id:page_id}`. The block library has ~40 ready-made block types — call list_block_types FIRST to discover them. Layout primitives: core/section, core/columns (2-slot Left/Right), core/grid (N-up; set last_row:'center' when item count doesn't divide by cols — never invent a wide card to fill an orphan row), core/container (flex), core/spacer, core/divider. Content: core/heading, core/prose, core/button, core/image, core/icon, core/icon_box. Marketing: core/hero, core/cta, core/testimonial, core/team_member, core/pricing_plan, core/post_card, core/step_card, core/logo_item. Interactive: core/accordion, core/tabs, core/search (site search — deploy pipeline indexes automatically). Media: core/video, core/form. Repeater aliases: core/gallery, core/logo_cloud, core/testimonials, core/feature_grid, core/pricing_table, core/team_grid, core/collection_list. Template-context: template/page_title, template/page_featured_image, template/site_logo etc. Position defaults to end-of-list.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Shorthand for target={kind:"page", id:page_id}.' },
        target: {
          type: 'object',
          description: 'Container address. kind=page|partial|template. For "another item on every page", pass {kind:"partial", id:"header"} or "footer".',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Block type id, e.g. "core/heading" or "user/{name}" for a custom block.' },
            data: { type: 'object', description: 'Field values matching the block-type schema.' },
          },
          required: ['type'],
        },
        parent_id: { type: 'string', description: 'Block id to nest inside. Omit for top-level.' },
        slot_index: { type: 'number', description: 'For slot-container parents (e.g. core/columns), which slot. Default 0.' },
        position: { type: 'number', description: 'Index in the target list. Default end.' },
      },
      required: ['block'],
    },
  },
  {
    name: 'update_block',
    description:
      "Update a block's data fields (shallow merge). Works on pages, partials, and page templates — pass `target` to address something other than a page. Does not touch children or slots — use add/move/remove for structural changes.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Shorthand for target={kind:"page",id:page_id}.' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block_id: { type: 'string' },
        data: { type: 'object', description: 'Fields to merge into block.data.' },
      },
      required: ['block_id', 'data'],
    },
  },
  {
    name: 'move_block',
    description:
      "Reparent or reorder a block within its container. target_parent_id=null moves to top level. For slot-container parents, set target_slot_index. Cycles (moving a block into its own descendant) are rejected. Use `target` to address a partial or template; `page_id` is the shorthand for a page.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block_id: { type: 'string' },
        target_parent_id: { type: ['string', 'null'] },
        target_slot_index: { type: 'number' },
        target_position: { type: 'number' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'remove_block',
    description: 'Remove a block (and everything inside it) from a container (page, partial, or template). Use `target` for non-page containers.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block_id: { type: 'string' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'duplicate_block',
    description: "Clone a block (including its subtree) and insert the copy directly after the original within the same container. Useful for adding another card to a feature grid, another testimonial to a carousel, etc. — clone the existing one and then update_block on the new id to tweak its data. Returns the duplicate's new id. Works for pages, partials, and templates.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block_id: { type: 'string' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'set_block_responsive',
    description: "Set per-breakpoint values for a responsive field on a block. Works for any container — page, partial, or template. The renderer accepts { mobile: ..., tablet: ..., laptop: ..., desktop: ..., wide: ... } objects on any field marked responsive in the BlockType schema (call read_block_type to see which). Mobile-first inheritance: missing breakpoints inherit from the previous defined one upward. Example: setting cols on a feature_grid to { mobile: 1, tablet: 2, desktop: 3 } gives 1 column on phones, 2 on tablets, 3 on desktop+. Pass a scalar to clear responsive (single value applies everywhere).",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['page', 'partial', 'template', 'item_template'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        block_id: { type: 'string' },
        field: { type: 'string', description: 'Field name (must be marked responsive in the BlockType schema).' },
        value: {
          description: 'Either a scalar (applies to all breakpoints) or an object with keys "mobile" / "tablet" / "laptop" / "desktop" / "wide".',
        },
      },
      required: ['block_id', 'field', 'value'],
    },
  },
  {
    name: 'set_page_mode',
    description:
      "Switch a page's content_mode between 'blocks' and 'html'. Snapshots a revision first, so the previous state is restorable from /pages/{id}/revisions. With convert=true, going html→blocks runs the heuristic converter so the page starts with a populated tree instead of empty. Blocks→html drops the tree (revision retains it).",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        to: { type: 'string', enum: ['blocks', 'html'] },
        convert: { type: 'boolean', description: 'Only matters for html→blocks. Default false.' },
      },
      required: ['page_id', 'to'],
    },
  },
  {
    name: 'convert_page_to_blocks',
    description:
      "Run the heuristic HTML→blocks converter on a page's html_content and return the proposed block tree without writing. Use this to inspect what set_page_mode(convert=true) would produce. Tags it recognises: <h1-4>→heading, <img>/<figure>→image, <a class='btn'>→button, grid-cols-2→columns, hero/section divs→section. Unrecognised content becomes core/prose blocks (lossless raw HTML wrapper).",
    input_schema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
    },
  },
  {
    name: 'list_block_types',
    description:
      "Discover every block type usable on this site. Returns ALL of them — core blocks (always available, ship in the platform), custom blocks (created in this site's portal), and third-party blocks (imported from .tcblocks packages). Each entry includes id, label, category, container/slot info, origin, and field_names. Call this FIRST when starting any block-mode work — never guess block ids or fields. For the full per-field schema (types, defaults, required) call read_block_type.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_block_type',
    description:
      "Full schema for one block type. Returns the BlockType doc with the field-definitions array (each field has name, type, label, required, options, default). Use this before add_block on an unfamiliar block type so you know which data fields to populate.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Block type id, e.g. "core/heading" or a custom id from list_block_types.' } },
      required: ['id'],
    },
  },

  // ─── BlockType authoring — create / update / delete ───────────────────
  // These three tools manage *types* (the schema definitions). Distinct
  // from add_block/update_block/etc. which manage *instances* of blocks
  // on a page. The `script` field is intentionally absent — AI cannot
  // ship custom JS to visitors. Origin is stamped 'ai' so the portal UI
  // can visually flag AI-authored types for audit.
  {
    name: 'create_block_type',
    description:
      "Create a new custom block type usable on this site. Use this when none of the existing blocks fit and the user needs a reusable shape (e.g. \"a card that pairs an icon with two columns of bullet points\"). The block ships immediately to every page editor and the renderer's registry. Origin is auto-stamped 'ai'. Custom JS via `script` requires the site's \"Allow AI to write block scripts\" setting (an org admin enables it in the portal under Settings) — when it's off, the script field is ignored with a warning. If the user asks for interactivity and the warning comes back, tell them about the setting, suggest adding the script manually in the block type editor, or point them to the API/MCP route where their own key carries the authority (audit-logged).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Machine name, lowercase kebab/underscore, 1-64 chars. Becomes the block type id.' },
        label: { type: 'string', description: 'Display label in the block picker.' },
        icon: { type: 'string', description: 'Lucide icon name (optional).' },
        category: { type: 'string', enum: ['layout', 'content', 'media', 'custom'], description: 'Picker category. Default custom.' },
        container: {
          description: 'Container kind. true = ordered children, slots = named slots, repeater = loops items[], conditional = renders children if condition truthy.',
        },
        slot_count: { type: 'number', description: 'Required when container="slots" (1-8).' },
        slot_labels: { type: 'array', items: { type: 'string' } },
        item_compatible: { type: 'boolean', description: 'Mark true if the block is designed to render as a repeater item (no outer padding, kernel layout).' },
        expand_to: {
          type: 'object',
          properties: { target: { type: 'string' }, defaults: { type: 'object' } },
          description: 'Alias to another block type — the renderer expands this block to `target` with `defaults` merged under authored data.',
        },
        schema: {
          type: 'array',
          description: 'FieldDefinition[]. Each field: { name, type, label, required?, default?, options?, responsive? }.',
        },
        template: { type: 'string', description: 'HTML body with {{field}}, {{{field}}}, {{=tag}}, {{children}}, {{slot:NAME}} substitutions. Outermost element should carry data-block="<name>".' },
        styles: { type: 'string', description: 'Block-scoped CSS. Selectors should start with [data-block="<name>"] so they don\'t leak.' },
        script: { type: 'string', description: 'Client-side JS shipped with the block (runs on the published site). Only honoured when the site has enabled AI block scripts; otherwise ignored with a warning in the result.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_block_type',
    description:
      "Update a custom or third-party block type. Core blocks (id starts with 'core/') are managed in platform code and cannot be changed here. Schema, template, and styles REPLACE wholesale when set — don't include them unless you want to overwrite. Other fields shallow-merge into the existing doc. The `script` field follows the same site-setting gate as create_block_type.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Block type id (must not start with "core/").' },
        label: { type: 'string' },
        icon: { type: 'string' },
        category: { type: 'string', enum: ['layout', 'content', 'media', 'custom'] },
        container: {},
        slot_count: { type: 'number' },
        slot_labels: { type: 'array', items: { type: 'string' } },
        item_compatible: { type: 'boolean' },
        expand_to: { type: 'object', properties: { target: { type: 'string' }, defaults: { type: 'object' } } },
        schema: { type: 'array' },
        template: { type: 'string' },
        styles: { type: 'string' },
        script: { type: 'string', description: 'Only honoured when the site has enabled AI block scripts; otherwise ignored with a warning.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_block_type',
    description:
      "Remove a custom or third-party block type. Core blocks cannot be deleted. Pages that reference the deleted block render `<!-- unknown block type -->` placeholders, so call find_pages_using_block_type FIRST and ASK THE USER before deleting if any pages are affected.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_page_templates',
    description:
      "List PageTemplate docs on this site. A template is a Block[] tree with a template_content_slot block — assigned to a page via set_page_template, the template wraps the page's body at render time.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_page_template',
    description: "Assign or clear a PageTemplate on a page (sets Page.template).",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        template_id: { type: ['string', 'null'], description: 'Template id, or null to clear.' },
      },
      required: ['page_id', 'template_id'],
    },
  },

  // Global blocks — header / footer / free
  {
    name: 'list_partials',
    description: 'List all global blocks on this site (header, footer, and reusable free blocks).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_partial',
    description: 'Read a global block including its HTML content. The navigation lives inside the header.',
    input_schema: {
      type: 'object',
      properties: { partial_id: { type: 'string', description: '"header", "footer", or the id of a free block.' } },
      required: ['partial_id'],
    },
  },
  {
    name: 'list_blocks_with_usage',
    description:
      'List all global blocks together with how many pages embed each one. Use this when deciding whether to extract a reusable block — it shows what is already composable and what is duplicated. Header/footer are reported as auto-injected (count = total pages).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_pages_using_block',
    description:
      'List pages that embed a given free block via <x-include name="…">. Use this before suggesting an edit to a shared block so you can tell the user how many pages will change. The header and footer are auto-injected on every page — calling this for partial_id="header" or "footer" returns the full page list.',
    input_schema: {
      type: 'object',
      properties: {
        partial_id: { type: 'string', description: 'Block id (e.g. "newsletter-cta", "header", "footer").' },
      },
      required: ['partial_id'],
    },
  },
  {
    name: 'update_partial',
    description:
      'Update or create a global block. Use partial_id="header"/"footer" for the auto-injected layout blocks, or any slug for a reusable free block (insert into a page with <x-include name="block-id" />). Provide the full HTML — never a diff.',
    input_schema: {
      type: 'object',
      properties: {
        partial_id: { type: 'string', description: '"header", "footer", or a kebab-case id for a free block.' },
        html_content: { type: 'string' },
        name: { type: 'string', description: 'Display name (e.g. "Newsletter CTA").' },
        kind: { type: 'string', enum: ['header', 'footer', 'free'], description: 'Override the kind. Defaults: id=header/footer get those kinds, anything else becomes "free".' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['partial_id', 'html_content'],
    },
  },

  // Design reference — the starter design system the site MAY follow
  {
    name: 'read_design_notes',
    description: 'Read the starter design system reference (CSS variables, header/footer skeletons, spacing scale). Only useful when the customer\'s site looks blank or clearly follows the starter conventions. For sites with custom designs, always inspect the actual existing partials/pages instead — mirror what is in use, do not impose this reference.',
    input_schema: { type: 'object', properties: {} },
  },

  // Playbook — recipes for common customer requests
  {
    name: 'read_playbook',
    description: 'Read the chat playbook: recipes for common customer requests (page URLs, listings, menu edits, embedding forms, etc.). Read this when a request looks like one of the common patterns — it saves you from re-deriving conventions every time.',
    input_schema: { type: 'object', properties: {} },
  },

  // Site settings — colors, fonts, contact info
  {
    name: 'read_site_settings',
    description: 'Get the site\'s settings: name, tagline, colors, fonts, contact info, social, scripts, custom CSS.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_site_settings',
    description:
      'Patch site settings. Only include the fields you want to change. Nested fields (colors, fonts, contact, social) are merged shallowly — provide whole nested objects only when replacing everything in them.',
    input_schema: {
      type: 'object',
      properties: {
        site_name: { type: 'string' },
        tagline: { type: 'string' },
        logo: { type: 'string' },
        favicon: { type: 'string' },
        apple_touch_icon: { type: 'string', description: 'URL to a 180x180 PNG for home-screen bookmarks (<link rel="apple-touch-icon">).' },
        colors: {
          type: 'object',
          properties: {
            primary: { type: 'string' },
            secondary: { type: 'string' },
            accent: { type: 'string' },
            background: { type: 'string' },
            surface: { type: 'string' },
            text: { type: 'string' },
            text_light: { type: 'string' },
          },
        },
        fonts: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            body: { type: 'string' },
            size_base: { type: 'number' },
          },
        },
        contact: {
          type: 'object',
          properties: { email: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } },
        },
        social: {
          type: 'object',
          properties: { facebook: { type: 'string' }, instagram: { type: 'string' }, linkedin: { type: 'string' }, x: { type: 'string' }, youtube: { type: 'string' } },
        },
        default_seo_suffix: { type: 'string' },
        default_meta_description: { type: 'string', description: 'Site-wide fallback <meta name="description"> used when a page has no seo_description; the tagline is the last-resort fallback.' },
        image_sizes_default: { type: 'string', description: 'Site-wide default `sizes` for responsive images, e.g. "(max-width: 640px) 360px, 560px". Tells the browser how wide images actually render so it picks the smallest sufficient srcset variant. A page can override via its own image_sizes_default; a per-<img> `sizes` attr wins over both.' },
        // Intentionally omitted: scripts_head, scripts_body_end, custom_css.
        // Those are scriptable surfaces that BaseLayout injects with set:html,
        // and we don't want the chat tool loop to be a prompt-injection path
        // into raw JS execution on every page. Users add those manually in
        // /app/sites/{id}/settings.
      },
    },
  },

  // Collections (blog, team, events, products, etc.)
  {
    name: 'list_collections',
    description: 'List all content collections on the site (blog, team, events, etc.) with their machine names and field schemas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_collection_items',
    description: 'List items in a collection. Returns id, status, and the first few fields of each item.',
    input_schema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection machine name (e.g. "blog").' },
        status: { type: 'string', enum: ['draft', 'published', 'all'], description: 'Filter by status. Defaults to "all".' },
        limit: { type: 'number' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'read_collection_item',
    description: 'Read all fields of a single collection item.',
    input_schema: {
      type: 'object',
      properties: { collection: { type: 'string' }, item_id: { type: 'string' } },
      required: ['collection', 'item_id'],
    },
  },
  {
    name: 'create_collection_item',
    description:
      'Create a new item in a collection. Provide the fields that exist in the collection\'s schema. Defaults to status=draft.',
    input_schema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Map of field_name → value. Must match the collection schema.',
          additionalProperties: true,
        },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['collection', 'fields'],
    },
  },
  {
    name: 'update_collection_item',
    description: 'Update fields on a collection item.',
    input_schema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        item_id: { type: 'string' },
        fields: { type: 'object', additionalProperties: true },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['collection', 'item_id'],
    },
  },
  {
    name: 'delete_collection_item',
    description: 'Delete a collection item permanently.',
    input_schema: {
      type: 'object',
      properties: { collection: { type: 'string' }, item_id: { type: 'string' } },
      required: ['collection', 'item_id'],
    },
  },

  // Media
  {
    name: 'list_media',
    description: 'List media items uploaded for this site. Use this to find an existing image URL before pasting one into a page.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },

  // Redirects
  {
    name: 'list_redirects',
    description: 'List existing redirect rules.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_redirect',
    description:
      'Create a redirect rule mapping an old path to a new path. Supports wildcard patterns: ' +
      'a trailing "*" captures everything below a prefix and ":splat" inserts it into the target ' +
      '(from_path "/category/*" → to_path "/blogg/:splat"), and ":name" matches exactly one segment ' +
      '(from_path "/blog/:slug" → to_path "/artiklar/:slug"). One rule can retire a whole family of ' +
      'dead WordPress URLs. A rule that would hide a live page is refused — narrow the pattern.',
    input_schema: {
      type: 'object',
      properties: {
        from_path: { type: 'string', description: 'Old path, including the leading slash (e.g. "/old-about"). May be a pattern: "/category/*" or "/blog/:slug". Only a TRAILING "*" is supported; query strings cannot be matched.' },
        to_path: { type: 'string', description: 'Target path or absolute URL. May reference ":splat" (when from_path ends in "*") or any ":name" the from_path declares.' },
        status_code: { type: 'number', enum: [301, 302] },
      },
      required: ['from_path', 'to_path'],
    },
  },

  // Forms
  {
    name: 'list_forms',
    description: 'List the forms defined for this site.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_form_embed',
    description:
      'Get the HTML-mode authoring directive for a form. Paste the returned <x-form> reference into page HTML; preview and static generation replace it server-side with the complete form shell, signed token, and initial state.',
    input_schema: {
      type: 'object',
      properties: { form_id: { type: 'string' } },
      required: ['form_id'],
    },
  },
];

// ─── System prompt ───────────────────────────────────────────────────────

export interface ActivePageContext {
  id: string;
  title: string;
  slug: string;
}

export function buildChatSystemPrompt(
  siteName: string,
  settings: SiteSettings | null,
  activePage: ActivePageContext | null = null,
): string {
  const colors = settings?.colors;
  return `You are the AI assistant for the website "${siteName}". You help the user manage the site by calling tools. You can edit pages, the navigation, the footer, site settings, content collections (blog posts, team members, events, etc.), media, and redirects.

# The system you're working in

This is Typeroll, a CMS that compiles to a static site (no database, no server code in production). Content lives in Firestore. You make changes by calling tools — never by claiming you did something without calling the tool.

## Drafts and saving — the buffer model

EVERY content edit you make (page bodies, blocks, SEO fields, partials, collection items) lands in an UNSAVED DRAFT (a "working copy") — the same layer the user's editor autosaves into. Drafts are visible in the editor and on the preview links your actions return, but they are NOT part of the saved page and are NEVER included in a deploy. Saving is always an explicit step:

- \`save_changes\` promotes a doc's draft onto the saved page (revision snapshot included) — call it when the user approves, or when they clearly asked for a finished change up front.
- \`discard_changes\` throws a draft away.
- Status changes (\`update_page_status\`) and structural operations (create/delete, mode switches, templates, settings, redirects) apply immediately — they are not content drafts.

Workflow: make the edits → point the user at the preview link → on approval, \`save_changes\` → if it should go live, deploy. If the user asks you to "publish" something, that means: save_changes + set status published (+ deploy if they want it live now). The editor shows your drafts as "Unsaved changes" in its Publish menu, so the user can also Save or Discard your work from there.

**The live site is the source of truth.** The current page/partial/settings content you read back through the tools is canonical — always \`read_page\` (or \`get_page_blocks\`) before editing and base your changes on what's actually there, not on memory, an earlier version, or a document the user pasted earlier in the chat. If the user wants to apply text from an external draft, they'll say so explicitly; otherwise preserve the live wording and structure and change only what was asked.

## Pages

Every page has:
- title, slug, status (draft | review | unlisted | published)
- content_mode: "blocks" (default for newly-created pages) or "html"
- For blocks-mode: \`blocks\` is a Block[] tree edited via add_block / update_block / move_block / remove_block
- For html-mode: \`html_content\` is the body HTML, edited via update_page_html
- seo_title, seo_description, og_image, canonical_url, noindex, json_ld
- template: optional PageTemplate id that wraps the body at render time

**Always call \`get_page_blocks\` (or \`read_page\`) FIRST to find out the mode.** The tools differ:

### Blocks-mode pages (the modern default)

Use granular tools: add_block, update_block, move_block, remove_block. Each takes \`page_id\` and identifies the block by \`block_id\`. No need to re-send the entire body for each edit.

**Discover blocks via tools — don't guess.** Call \`list_block_types\` to see every block usable on this site (core + custom + third-party in one list). The response gives you each block's id, label, category, container/slot info, and field_names. For an unfamiliar block, call \`read_block_type id=<id>\` to get the full per-field schema (types, defaults, required, options for select fields). The available set is per-site — custom and third-party blocks change what's possible. Never hardcode block ids or field names based on prior memory.

Typical workflow:

\`\`\`
list_block_types
  → [{ id: "core/section", category: "layout", container: true, … },
     { id: "core/columns", container: "slots", slot_count: 2, slot_labels: ["Left","Right"], … },
     { id: "hero_bold", origin: "user", … },  // example custom block
     …]

read_block_type id="core/section"
  → full BlockType with schema: [{ name: "width", type: "select", options: ["narrow","normal","wide","full"] }, …]

add_block page_id=home block={ type: 'core/section', data: { width: 'wide' } }
  → { added_id: 'blk_aaa', … }
add_block page_id=home parent_id='blk_aaa' block={
  type: 'core/heading', data: { text: 'Pricing', level: 'h2' }
}
add_block page_id=home parent_id='blk_aaa' block={
  type: 'core/columns', data: { ratio: '1-1' }
}
  → { added_id: 'blk_ccc', … }
add_block page_id=home parent_id='blk_ccc' slot_index=0 block={
  type: 'core/prose', data: { html: '<p>Left column</p>' }
}
\`\`\`

For slot-containers, \`slot_index\` maps to the slot_labels in the block type (e.g. core/columns has Left=0, Right=1). For regular containers (\`container: true\`), children go into a single ordered list.

### The block library — what's there and how to compose it

The platform ships ~40 blocks. \`list_block_types\` is authoritative; below is a high-level guide so you know what's likely available without listing first.

**Layout primitives.** Reach for these to structure a page:
- \`core/section\` — outer container, sets width + vertical padding + background
- \`core/container\` — flex container with direction/gap/align control
- \`core/grid\` — N-column grid (responsive \`cols\`); the right pick for 3-up/4-up tiles
- \`core/columns\` — 2-slot Left/Right container; pick this for "image on left, text on right" patterns where each side is its own content
- \`core/spacer\` / \`core/divider\` — vertical whitespace / visible separator

**Marketing & content.** The blocks that show up on landing pages:
- \`core/hero\` — top-of-page hero (eyebrow + heading + sub + buttons; 4 layout variants)
- \`core/cta\` — call-to-action band, often before a footer or between sections
- \`core/heading\` / \`core/prose\` / \`core/button\` / \`core/image\` — primitives
- \`core/icon\` / \`core/icon_box\` — \`icon_box\` is the canonical feature card. \`icon\` fields render inline SVG when the value is a known icon name (curated Lucide subset — \`check\`, \`star\`, \`shield-check\`, \`mail\`, \`arrow-right\`, \`zap\`, \`truck\`, \`chart-line\`, …; full list in get_site_capabilities → core_icon_names). Emoji or plain text values render as text, so emoji stand-ins still work. Applies to core/icon, core/icon_box, core/step_card.
- \`core/accordion\` / \`core/tabs\` — interactive disclosure / tabs
- \`core/video\` — YouTube/Vimeo/URL with aspect ratio
- \`core/form\` — contact form posting to /api/forms/submit

**Repeater aliases** — when you'd otherwise tile the same shape N times, use these instead of N add_blocks. Each alias loops a list of items via a single block:
- \`core/gallery\`         — images
- \`core/logo_cloud\`      — client logos (greyscale by default)
- \`core/testimonials\`    — testimonial carousel
- \`core/feature_grid\`    — icon_box grid (3-up by default)
- \`core/pricing_table\`   — pricing_plan grid
- \`core/team_grid\`       — team_member grid
- \`core/collection_list\` — blog/news/any collection, items become post_cards

Author-friendly: pass \`items: [{...}, {...}]\` on the alias block. The renderer expands each to the right item-block type. So one \`add_block({ type: 'core/feature_grid', data: { items: [{icon:'zap', heading:'Fast', text:'<p>...</p>'}, ...] } })\` call replaces six add_blocks for section + 3-grid + 3 icon_boxes.

**Item-compatible blocks** (\`testimonial\`, \`team_member\`, \`pricing_plan\`, \`post_card\`, \`logo_item\`, \`step_card\`, \`icon_box\`) are the kernels each alias uses. They render fine standalone too — drop one into a \`core/grid\` if you need a custom shape the alias doesn't cover.

**Template/* blocks** — only meaningful inside a PageTemplate. They bind to the render context:
- \`template/page_title\`           → \`{{page.title}}\`
- \`template/page_featured_image\`  → \`{{page.featured_image}}\`
- \`template/page_author\`, \`template/page_date\`, \`template/page_excerpt\`, \`template/page_breadcrumbs\`
- \`template/site_logo\`, \`template/site_title\`, \`template/site_tagline\`
- \`template/item_title\` / \`template/item_body\` / \`template/item_image\` (for collection item templates)
- \`template/show_if\` — container that renders children only if a condition is truthy (e.g. \`page.featured_image\` or \`page.status === "published"\`)

When you add a blog template, prefer these over hand-rolling \`core/heading\` with \`{{page.title}}\` in its data — they surface in the editor as named entities.

### Responsive values

Any field marked \`responsive: true\` in the BlockType schema accepts either a scalar (same value at every breakpoint) or a partial object with keys \`mobile\` / \`tablet\` / \`laptop\` / \`desktop\` / \`wide\`. Missing breakpoints inherit upward from the previous defined one (mobile-first).

Use \`set_block_responsive\` to apply per-breakpoint values:

\`\`\`
set_block_responsive page_id=home block_id=blk_grid field=cols value={ mobile: 1, tablet: 2, desktop: 3 }
\`\`\`

Common candidates: \`cols\` on grid/repeater, \`padding_y\` / \`padding_x\` / \`gap\` on container, \`size\` on heading (when you want a smaller hero on mobile than fluid clamp() chose), \`layout\` on hero (split on desktop, centered on mobile). \`Block.hidden_on: ['mobile']\` hides the entire block at a breakpoint — no BlockType opt-in needed.

Headings already shrink fluidly on small screens via clamp(), so per-bp \`size\` is only needed for unusual cases.

### Reorganising the page

- \`duplicate_block\` — clones a block (subtree included) and inserts the copy right after the original. Best way to add another card to a feature_grid / testimonial carousel: duplicate, then update_block on the new id to change its data.
- \`move_block\` — re-parent or reorder; cycles rejected.
- \`remove_block\` — drops a block + its descendants.

### Block containers — pages, partials, templates

Pages aren't the only place blocks live. The same instance tools — \`add_block\`, \`update_block\`, \`move_block\`, \`remove_block\`, \`duplicate_block\`, \`set_block_responsive\`, \`get_page_blocks\` — operate on any **container**, addressed by:

\`\`\`
target: { kind: 'page' | 'partial' | 'template', id: '<container_id>' }
\`\`\`

\`page_id: 'foo'\` is the legacy shorthand for \`target: { kind: 'page', id: 'foo' }\` — both still work.

- **\`target: { kind: 'partial', id: 'header' }\`** — drop a block in the header that appears on every page. Same for \`'footer'\` or any free-block id from \`list_partials\`. Only works on partials that are in blocks-mode; html-mode partials reject the call (use \`update_partial\` for those).
- **\`target: { kind: 'template', id: 'blog-post' }\`** — edit a PageTemplate's block tree. Every page assigned that template re-renders with the change. Template trees usually mix \`template_content_slot\` (where the page body goes) with \`template/page_title\`, \`template/page_featured_image\`, etc.
- **\`target: { kind: 'page', id: '<page_id>' }\`** — same as \`page_id\`.

When a user asks for "a CTA at the top of every page", the right move is almost always \`add_block target={kind:'partial', id:'header'}\` (or a new free block, then \`<x-include>\` it from the existing header partial), NOT N add_blocks across N pages.

### BlockType authoring vs block instances

These are two separate verb families — keep them straight:

- **BlockType tools** (\`list_block_types\`, \`read_block_type\`, \`create_block_type\`, \`update_block_type\`, \`delete_block_type\`) manage the *schema definitions* — the things that show up in the block picker. Origin is stamped \`'ai'\` on creates. Custom JS (\`script\`) is available only when the site has "Allow AI to write block scripts" enabled (a human-set site setting); when it's off your script is ignored and the result carries a warning — tell the user about the setting or suggest adding the script manually in the block type editor.
- **Block instance tools** (\`add_block\`, \`update_block\`, \`move_block\`, \`remove_block\`, \`duplicate_block\`, \`set_block_responsive\`) manage *placements* of blocks inside a container (page/partial/template).

A request like "make me a custom testimonial card with a star rating built in" is BlockType work (\`create_block_type\`); a request like "add another testimonial to the home page" is instance work (\`add_block\` or \`duplicate_block\`).

### HTML-mode pages

When you edit an HTML-mode page, you must provide the FULL new HTML body via \`update_page_html\`. The tool replaces the whole thing. So always read_page first, then output the full body with your changes applied. Preserve existing structure, tone, and unrelated sections.

### Switching modes

\`set_page_mode page_id=foo to=blocks convert=true\` flips an HTML page to blocks-mode and runs the heuristic converter. It snapshots a revision first so the previous state is restorable. The converter recognises common patterns (headings, images, buttons, two-column grids, sections); anything else lands as a \`core/prose\` block preserving the raw HTML losslessly.

Use \`convert_page_to_blocks page_id=foo\` to preview the proposed conversion without writing — useful before committing on a long page.

### Templates

A PageTemplate is a Block[] tree containing one or more \`template_content_slot\` blocks. Assigning a template to a page (\`set_page_template page_id=foo template_id=blog-post\`) wraps the page's blocks in the template at render time. Use \`list_page_templates\` to see what's on the site.

**URLs.** When the user asks for the URL of a page, use the \`live_url\` and \`preview_url\` fields from \`list_pages\` / \`read_page\` — never guess based on slug, never invent a domain like "your-site-url.com". Both are absolute URLs ready to click. The preview URL is rendered live from the database on every request (no rebuild needed) and includes the user's latest drafts and edits. \`live_url\` is null when the page is unpublished or the site has no domain configured; in that case point the user at \`preview_url\` and explain that the live URL becomes available once they set a domain in Settings and publish/deploy.

## Global blocks (header, footer, free blocks)

Three flavours, all managed via update_partial / read_partial / list_partials:

1. **header** (id="header", kind="header") — auto-injected at the top of every page. The site's main navigation lives here. Call update_partial with partial_id="header" and the full new header HTML.
2. **footer** (id="footer", kind="footer") — auto-injected at the bottom of every page. Same idea with partial_id="footer".
3. **free blocks** (kind="free") — reusable HTML you can drop into any page with \`<x-include name="block-id" />\` (the renderer expands it at build time using the published version). Good for announcement bars, newsletter CTAs, cookie banners, anything that appears on multiple pages and should change in one place. Call update_partial with a kebab-case partial_id (e.g. "newsletter-cta") and the full HTML; the kind defaults to "free" for anything that isn't header/footer.

When updating the header, keep the brand/logo area and the nav links structure unless the user asked you to redo them.

When the user wants to embed a free block in a page, edit the page's html_content and add \`<x-include name="block-id" />\` where it should appear — don't paste the block's HTML inline, that defeats the point.

# Design — mirror what's already there

Every site has its own visual conventions, and they vary widely. A new
Typeroll site uses a CSS-variables design system; a migrated WordPress
site might use hardcoded classes; a customer who built their own design
might use neither. Don't assume.

Before designing anything new — a new page, a section, a redesigned header
— **read at least one existing partial or page first** to learn the
conventions actually in use on THIS site. Mirror them. Preserve the look
the customer has been building.

If the site is essentially blank (no header partial, default settings, no
custom pages), or if the existing partials clearly follow the starter
design (CSS variables like \`var(--color-primary)\`, \`var(--container-medium)\`,
etc.), call \`read_design_notes\` for the starter spec — variables, header/
footer skeleton, spacing scale, the works.

Hard rules either way:
- When you edit the header or footer, **preserve the existing skeleton**
  (brand block, nav block, footer columns) unless the customer explicitly
  asks for a redesign.
- When the customer specifies a literal value ("use #ff5500", "make it
  Inter Bold 32px"), honor that literal value — don't substitute a CSS
  variable for it.
- When matching an existing site that uses theme variables, never hardcode
  a value the site already exposes as a variable. Hardcoded colors break
  the next theme update.

## Site settings

Settings include name, tagline, logo, favicon, apple_touch_icon (180×180 PNG for home-screen bookmarks), colors (primary/secondary/accent/background/surface/text/text_light), fonts (heading/body — Google Font family names), contact info, social links, head/body scripts, custom CSS, the SEO title suffix, and the default meta description (default_meta_description — the site-wide fallback <meta name="description"> when a page has no seo_description; the tagline is the last resort). Use update_site_settings to change any of these. When the brand assets include icon files, set favicon AND apple_touch_icon as part of initial setup — don't leave them empty.

When the user asks to change brand colors, fonts, or contact info — that's site settings, not a page edit.

## Content collections

Collections are repeatable content types — blog posts, team members, events, products, anything. Each collection has a schema (field definitions). Items in a collection have those fields.

When the user says "add a blog post" or "add Sarah to the team page":
1. Call list_collections to find the right one (you'll see field names + types).
2. Call create_collection_item with collection=name and fields={...} matching the schema.
3. Default status is "draft". Set "published" if the user said publish.

When the user says "show our blog posts on the homepage" or "add a list of upcoming events":
1. Call list_collection_items to fetch the items.
2. Edit the relevant page's HTML to include a hand-written list rendering those items (with their titles, dates, links, images). Use simple semantic HTML with the site's CSS variables for styling.
3. The static site has no template engine — you're literally writing the listing HTML into the page based on the current items. If the user adds more items later, ask them whether you should regenerate the listing.

## Media

When the user attaches an image, it's uploaded to the CDN and you'll see its URL. Reference it in HTML as <img src="..." alt="...">. To find an existing image, call list_media.

## Redirects

Use create_redirect when a page's URL changes or when the user asks to forward an old URL to a new one.

## Forms

When the user asks to put a form on a page (contact form, signup, etc.):
1. Call list_forms to find the form id.
2. Call get_form_embed with that id — it returns an <x-form> authoring directive.
3. Paste the directive into the page's html_content where the user wants the form. The renderer expands it server-side to the same complete shell as core/form.

Do NOT hand-write a <form> element. The <x-form> directive is expanded server-side with a valid signed token and initial state.

# Scope: default to the page in front of the user

Unless the customer explicitly asks for a site-wide change, scope edits to
the single page they're referencing. If no page is referenced and the
request could apply to many, **ask which page** before guessing — don't
fan out across the whole site.${
    activePage
      ? `

**The customer is currently editing the page "${activePage.title}" (id: \`${activePage.id}\`, slug: \`/${activePage.slug}\`).** When they say "this page", "the page", "here", or give an instruction without naming a page, they mean this one. \`read_page\` it before editing — don't ask which page they mean.`
      : ''
  }

# When to use a global block instead of editing every page

If the user asks for something that should appear on multiple pages — an
announcement bar, a CTA, contact info, a cookie notice, anything shared —
the answer is almost never "paste the same HTML into N pages". The answer
is a global block:

1. Call \`list_partials\` to see what's already shared on this site.
2. If a relevant block already exists, edit that block — every page that
   includes it updates with one save.
3. If nothing fits, propose creating a new free block (\`update_partial\`
   with a kebab-case id) and embedding it with \`<x-include name="block-id" />\`
   on the pages that should show it.
4. Only fall back to per-page edits when the content is genuinely
   per-page (different copy on each one — e.g. SEO descriptions).

Use \`find_pages_using_block\` before suggesting an edit to an existing
shared block so you can tell the user the blast radius ("this will change
on 8 pages — proceed?").

# Working style

- For common requests (page URLs, listings, menu edits, embedding forms, etc.), call \`read_playbook\` early — it's a short reference of how we want these handled. Don't re-derive conventions you'd find there.
- Be specific about what you did. After a tool call, summarize the change in 1-2 sentences. Never paste the full HTML back to the user.
- If you're unsure which page/item the user means, call list_* and ask before editing.
- When updating HTML, preserve existing classes and inline styles unless asked to redo them. Read an adjacent partial/page first to learn the design conventions in use, then match them — see the "Design — mirror what's already there" section above.
- Use semantic HTML: <section>, <h1>/<h2>/<h3>, <p>, <ul>/<li>, <a>. Avoid div soup.
- New pages and items default to "draft" status. Don't auto-publish unless the user said so.

# Current site context

- Site: ${siteName}${settings?.tagline ? `\n- Tagline: ${settings.tagline}` : ''}${colors ? `\n- Primary color: ${colors.primary}, accent: ${colors.accent}` : ''}${settings?.fonts ? `\n- Fonts: ${settings.fonts.heading} (heading) / ${settings.fonts.body} (body)` : ''}`;
}

// ─── Run loop ────────────────────────────────────────────────────────────

export async function runChatTurn(args: {
  orgId: string;
  siteId: string;
  versionId: string;
  siteName: string;
  site: Site;
  version: SiteVersion | null;
  portalOrigin: string;
  message: string;
  history: ChatMessageInput[];
  activePage?: ActivePageContext | null;
}): Promise<ChatResult> {
  const client = await getAnthropic(args.orgId);
  if (!client) {
    return {
      reply:
        "I'm not configured to chat yet — the server is missing an ANTHROPIC_API_KEY. Once that's set, I can edit your pages, navigation, content collections, settings, and more directly.",
      actions: [],
      tool_calls: [],
      iterations: 0,
    };
  }

  const store = getStore();
  const settings = await vstore.settings(args.orgId, args.siteId, args.versionId);
  const actions: ChatAction[] = [];
  const toolCalls: ChatToolCallLog[] = [];

  const conversation: Anthropic.MessageParam[] = [
    ...args.history.map((m): Anthropic.MessageParam => ({ role: m.role, content: m.content })),
    { role: 'user', content: args.message },
  ];

  let iterations = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1;
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 4096,
      system: buildChatSystemPrompt(args.siteName, settings, args.activePage ?? null),
      tools,
      messages: conversation,
    });

    conversation.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      return { reply: text || 'Done.', actions, tool_calls: toolCalls, iterations };
    }

    const toolUses = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const inputPreview = previewJson(use.input);
      try {
        const out = await runTool(use.name, use.input as Record<string, unknown>, {
          orgId: args.orgId,
          siteId: args.siteId,
          versionId: args.versionId,
          site: args.site,
          version: args.version,
          portalOrigin: args.portalOrigin,
        });
        if (out.action) actions.push(out.action);
        toolCalls.push({
          name: use.name,
          input_preview: inputPreview,
          ok: true,
          result_preview: previewJson(out.result),
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out.result),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Tool error';
        toolCalls.push({
          name: use.name,
          input_preview: inputPreview,
          ok: false,
          result_preview: '',
          error: msg,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: msg,
          is_error: true,
        });
      }
    }
    conversation.push({ role: 'user', content: toolResults });
  }

  return {
    reply: "I made several changes but ran out of room. Let me know if there's more.",
    actions,
    tool_calls: toolCalls,
    iterations,
  };
}

export interface ToolContext {
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site;
  version: SiteVersion | null;
  portalOrigin: string;
}

function absolutePreviewUrl(ctx: ToolContext, page: Parameters<typeof pagePreviewUrl>[1]): string {
  // ?draft=1 → the preview shows the working copy (the chat's edits are
  // drafts until saved), matching what the user sees in the editor.
  const path = pagePreviewUrl(ctx.siteId, page) + '?draft=1';
  return path.startsWith('http') ? path : `${ctx.portalOrigin}${path}`;
}

/** Ctx triple for the working-copy / content-write libs. */
function wcCtx(ctx: ToolContext): { orgId: string; siteId: string; versionId: string } {
  return { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId };
}

/**
 * Compose the ChatAction payload for a block-container mutation. Page
 * mutations get a preview_url that points at the page; partial / template
 * mutations don't have a single canonical URL so the target is the
 * partial/template id and the description identifies the kind.
 */
function containerAction(
  target: BlockContainerTarget,
  loaded: import('./block-containers').LoadedContainer,
  ctx: ToolContext,
  description: string,
): ChatAction {
  if (target.kind === 'page') {
    return {
      type: 'update_page',
      description,
      target: target.id,
      preview_url: loaded.pageSlug != null
        ? absolutePreviewUrl(ctx, { slug: loaded.pageSlug })
        : undefined,
    };
  }
  return {
    type: target.kind === 'partial' ? 'update_partial' : 'update_settings',
    description,
    target: target.id,
  };
}

interface ToolOutput {
  result: unknown;
  action?: ChatAction;
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const store = getStore();

  switch (name) {
    // ─── Pages ─────────────────────────────────────────────────────────────
    case 'list_pages': {
      const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
      return {
        result: pages.map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          content_mode: p.content_mode,
          status: p.status,
          live_url: pageLiveUrl(ctx.site, ctx.version, p),
          preview_url: absolutePreviewUrl(ctx, p),
        })),
      };
    }

    case 'read_page': {
      const id = String(input.page_id);
      const saved = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!saved) return { result: { error: 'Page not found' } };
      // Draft view — the page as it looks with unsaved edits overlaid.
      const pageWc = await readWorkingCopy(wcCtx(ctx), { kind: 'page', id });
      const page = overlayWorkingCopy(saved, pageWc);
      return {
        result: {
          id: page.id,
          has_unsaved_changes: !!pageWc,
          title: page.title,
          slug: page.slug,
          content_mode: page.content_mode,
          html_content: page.html_content ?? '',
          seo_title: page.seo_title,
          seo_description: page.seo_description,
          og_image: page.og_image,
          canonical_url: page.canonical_url,
          noindex: page.noindex,
          status: page.status,
          live_url: pageLiveUrl(ctx.site, ctx.version, page),
          preview_url: absolutePreviewUrl(ctx, page),
        },
      };
    }

    case 'update_page_html': {
      const id = String(input.page_id);
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      if (existing.content_mode && existing.content_mode !== 'html')
        return { result: { error: 'Page is not in HTML mode' } };
      await applyContentWrite(wcCtx(ctx), { kind: 'page', id }, {
        html_content: String(input.html_content ?? ''),
      }, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, page_id: id, draft: true },
        action: {
          type: 'update_page_html',
          description: `Updated the body of "${existing.title}" (unsaved draft).`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'update_page_seo': {
      const id = String(input.page_id);
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      const update: Record<string, unknown> = {};
      for (const k of [
        'seo_title', 'append_seo_suffix', 'seo_description', 'og_image', 'seo_image_alt',
        'canonical_url', 'noindex', 'lastmod_override',
        'schema_type', 'service', 'kind', 'author',
      ] as const) {
        if (input[k] !== undefined) update[k] = input[k];
      }
      await applyContentWrite(wcCtx(ctx), { kind: 'page', id }, update, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, page_id: id, draft: true },
        action: {
          type: 'update_page_seo',
          description: `Updated SEO for "${existing.title}" (unsaved draft).`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'add_faq_schema': {
      const id = String(input.page_id);
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      const items = (input.items as Array<{ question: string; answer: string }>) ?? [];
      const ld = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: items.map((it) => ({
          '@type': 'Question',
          name: it.question,
          acceptedAnswer: { '@type': 'Answer', text: it.answer },
        })),
      };
      await applyContentWrite(wcCtx(ctx), { kind: 'page', id }, {
        json_ld: JSON.stringify(ld),
      }, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, page_id: id, item_count: items.length, draft: true },
        action: {
          type: 'add_faq_schema',
          description: `Attached FAQ schema (${items.length} Q&A) to "${existing.title}" (unsaved draft).`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'add_recipe_schema': {
      const id = String(input.page_id);
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      const ingredients = (input.ingredients as string[]) ?? [];
      const instructionsRaw = (input.instructions as string[]) ?? [];
      const ld: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Recipe',
        name: String(input.name ?? existing.title),
        recipeIngredient: ingredients,
        recipeInstructions: instructionsRaw.map((step, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          text: step,
        })),
      };
      for (const [k, v] of [
        ['description', input.description],
        ['image', input.image_url],
        ['prepTime', input.prep_time],
        ['cookTime', input.cook_time],
        ['totalTime', input.total_time],
        ['recipeYield', input.recipe_yield],
      ] as const) {
        if (v) ld[k] = v;
      }
      if (input.author) ld.author = { '@type': 'Person', name: input.author };
      await applyContentWrite(wcCtx(ctx), { kind: 'page', id }, {
        json_ld: JSON.stringify(ld),
      }, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, page_id: id, draft: true },
        action: {
          type: 'add_recipe_schema',
          description: `Attached Recipe schema to "${existing.title}" (unsaved draft).`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'add_event_schema': {
      const id = String(input.page_id);
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      const ld: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: String(input.name ?? existing.title),
        startDate: String(input.start_date),
      };
      if (input.end_date) ld.endDate = input.end_date;
      if (input.description) ld.description = input.description;
      if (input.image_url) ld.image = input.image_url;
      if (input.location_name || input.location_address) {
        ld.location = {
          '@type': 'Place',
          name: input.location_name ?? undefined,
          address: input.location_address ?? undefined,
        };
      }
      if (input.offers_url || input.offers_price) {
        ld.offers = {
          '@type': 'Offer',
          url: input.offers_url ?? undefined,
          price: input.offers_price ?? undefined,
          priceCurrency: input.offers_currency ?? undefined,
          availability: 'https://schema.org/InStock',
        };
      }
      await applyContentWrite(wcCtx(ctx), { kind: 'page', id }, {
        json_ld: JSON.stringify(ld),
      }, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, page_id: id, draft: true },
        action: {
          type: 'add_event_schema',
          description: `Attached Event schema to "${existing.title}" (unsaved draft).`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'update_page_status': {
      const id = String(input.page_id);
      const status = String(input.status) as Page['status'];
      const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!existing) return { result: { error: 'Page not found' } };
      const update: Partial<Page> = { status, date_updated: new Date().toISOString() };
      if (status === 'published' && !existing.date_published) update.date_published = new Date().toISOString();
      await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, id, update);
      // A page going live retires any redirect FROM its URL — otherwise the
      // deploy's `_redirects` shadows the page on Cloudflare Pages.
      const { isLivePageStatus, retireRedirectsShadowingUrl } = await import('./redirect-hygiene');
      if (isLivePageStatus(status)) {
        const { pageUrlFromDoc } = await import('./page-paths');
        await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, pageUrlFromDoc(existing));
      }
      return {
        result: { ok: true },
        action: {
          type: 'update_page_status',
          description: `Set "${existing.title}" to ${status}.`,
          target: id,
          preview_url: absolutePreviewUrl(ctx, existing),
        },
      };
    }

    case 'save_changes':
    case 'discard_changes': {
      const kind = String(input.kind) as 'page' | 'partial' | 'item';
      const id = String(input.id);
      if (kind !== 'page' && kind !== 'partial' && kind !== 'item') {
        return { result: { error: 'kind must be page | partial | item' } };
      }
      const target: WcTarget = kind === 'item'
        ? { kind, collection: String(input.collection ?? ''), id }
        : { kind, id };
      if (kind === 'item' && !(target as { collection?: string }).collection) {
        return { result: { error: 'collection is required when kind="item"' } };
      }
      try {
        if (name === 'discard_changes') {
          await discardWorkingCopy(wcCtx(ctx), target);
          return {
            result: { ok: true, discarded: true },
            action: { type: 'update_page', description: `Discarded the unsaved draft of ${kind} ${id}.`, target: id },
          };
        }
        const commit = await commitWorkingCopy(wcCtx(ctx), target, 'chat-ai');
        return {
          result: {
            ok: true,
            saved: commit.committed,
            seo_warnings: commit.seo_warnings,
            note: commit.committed ? undefined : 'Nothing to save — no unsaved draft found.',
          },
          action: { type: 'update_page', description: `Saved ${kind} ${id}.`, target: id },
        };
      } catch (e) {
        if (e instanceof WorkingCopyError) return { result: { error: e.message } };
        throw e;
      }
    }

    case 'create_page': {
      const title = String(input.title ?? '').trim();
      if (!title) return { result: { error: 'title required' } };
      const existing = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
      const rawRequested = (input.slug ? String(input.slug) : slugify(title)) || 'page';
      // Slug remains a single segment (the leaf id). For nested URLs the
      // caller sets `path` instead — see docs/page-path-plan.md and the
      // page-paths lib for the shared validator.
      const requested = rawRequested.replace(/^\/+/, '').replace(/\/+$/, '');
      if (requested.includes('/')) {
        return {
          result: {
            error: `Slug "${input.slug}" contains a slash. Page slugs must be a single path segment. ` +
              `For nested URLs, set the \`path\` field explicitly (e.g. "/erbjudanden/sommar").`,
          },
        };
      }
      // Validate `path` if present. The chat tool's input is loosely
      // typed so we route it through the same validator the v1 route
      // uses.
      const { validatePathField, makeSafePageId, pageUrlFromDoc } = await import('./page-paths');
      const pathCheck = validatePathField(input.path);
      if (!pathCheck.ok) return { result: { error: `Invalid path: ${pathCheck.error}` } };
      const explicitPath = pathCheck.path;
      let slug = requested;
      let resolvedPath = explicitPath || `/${slug}`;
      let pageId = explicitPath ? makeSafePageId(resolvedPath) : slug;
      let i = 2;
      const urlTaken = (urlPath: string) => existing.some((p) => pageUrlFromDoc(p) === urlPath);
      const idTaken = (id: string) => existing.some((p) => p.id === id);
      while (urlTaken(resolvedPath) || idTaken(pageId)) {
        slug = `${requested}-${i}`;
        resolvedPath = explicitPath
          ? explicitPath.replace(/[^/]+$/, slug)
          : `/${slug}`;
        pageId = explicitPath ? makeSafePageId(resolvedPath) : slug;
        i++;
      }
      const status = (input.status as Page['status']) || 'draft';
      // Block-mode is the platform default. The model can opt into HTML
      // by passing `content_mode: 'html'` OR by providing `html_content`
      // (the body field is the strong intent signal).
      const requestedMode = typeof input.content_mode === 'string'
        ? String(input.content_mode).toLowerCase()
        : '';
      const useHtml = requestedMode === 'html'
        || (requestedMode === '' && typeof input.html_content === 'string');
      const baseDoc: Record<string, unknown> = {
        title,
        slug,
        ...(explicitPath ? { path: resolvedPath } : {}),
        content_mode: useHtml ? 'html' : 'blocks',
        status,
        seo_title: input.seo_title ? String(input.seo_title) : undefined,
        seo_description: input.seo_description ? String(input.seo_description) : undefined,
        ai_generated: true,
        date_updated: new Date().toISOString(),
      };
      if (useHtml) {
        baseDoc.html_content = String(input.html_content ?? '');
      } else {
        // Seed with a heading + prose block so the editor isn't a blank
        // canvas — matches the portal UI's "New page" behaviour.
        baseDoc.blocks = [
          {
            id: `blk_${Math.random().toString(36).slice(2, 14)}`,
            type: 'core/heading',
            data: { text: title, level: 'h1', align: 'left', eyebrow: '' },
          },
          {
            id: `blk_${Math.random().toString(36).slice(2, 14)}`,
            type: 'core/prose',
            data: { html: '<p>Start writing…</p>', max_width: 'normal' },
          },
        ];
      }
      await store.setDoc(`${paths.pages(ctx.orgId, ctx.siteId, ctx.versionId)}/${pageId}`, baseDoc);
      // A live page created on a URL retires any redirect FROM it (a real
      // page beats a redirect — see lib/redirect-hygiene.ts). Drafts leave
      // redirects alone; retirement happens at publish.
      {
        const { isLivePageStatus, retireRedirectsShadowingUrl } = await import('./redirect-hygiene');
        if (isLivePageStatus(status)) {
          await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, resolvedPath);
        }
      }
      return {
        result: { ok: true, page_id: pageId, slug, ...(explicitPath ? { path: resolvedPath } : {}), url: resolvedPath },
        action: {
          type: 'create_page',
          description: `Created "${title}" (${status}).`,
          target: pageId,
          preview_url: absolutePreviewUrl(ctx, explicitPath ? { slug: resolvedPath } : { slug }),
        },
      };
    }

    // ─── Block-mode container mutations ────────────────────────────────────
    // All seven tools accept either `page_id` (legacy shorthand) or a
    // generic `target: { kind: 'page'|'partial'|'template', id }`.
    // The block mutations themselves are container-agnostic — only the
    // load/write path differs by kind. Pages reject early when in
    // html-mode; partials reject early when in html-mode; templates
    // are always block trees so the check is a no-op there.
    case 'get_page_blocks': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        // For page-kind, fall through to the legacy behaviour so HTML-mode
        // pages return their html_content (helps the AI know to switch modes).
        if (target.kind === 'page') {
          const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
          if (!page) return { result: { error: 'Page not found' } };
          if (page.content_mode === 'blocks') {
            return { result: { content_mode: 'blocks', blocks: page.blocks ?? [] } };
          }
          return { result: { content_mode: 'html', html_content: page.html_content ?? '' } };
        }
        const loaded = await loadContainer(target, ctx);
        return { result: { content_mode: 'blocks', blocks: loaded.blocks } };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        throw e;
      }
    }

    case 'add_block': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      const blockInput = input.block as Partial<Block> | undefined;
      if (!blockInput?.type) return { result: { error: 'block.type is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        // Instance-level script gate. Block data isn't covered by the
        // per-type `script` gate, so a block type declaring script_fields
        // would otherwise let the chat write visitor-executed JS around it.
        const { resolveScriptFields, gateBlockInstanceScript } = await import('./block-script-gate');
        const scriptWarnings = gateBlockInstanceScript(
          blockInput.data as Record<string, unknown> | undefined,
          await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, blockInput.type),
          ctx.site,
        );
        const result = addBlockMutation(loaded.blocks, {
          block: { id: '', data: {}, ...blockInput } as Block,
          parent_id: input.parent_id as string | null | undefined,
          slot_index: input.slot_index as number | undefined,
          position: input.position as number | undefined,
        });
        await writeContainer(target, result.blocks, ctx, loaded.raw);
        return {
          result: {
            ok: true, added_id: result.added_id, block_count: result.blocks.length,
            ...(scriptWarnings.length ? { warnings: scriptWarnings } : {}),
          },
          action: containerAction(target, loaded, ctx, `Added a ${blockInput.type} block to ${targetLabel(target, loaded)}.`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'update_block': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        // Gate against the EXISTING block's type — the caller sends only a
        // data patch, so the type has to come from the tree.
        const { resolveScriptFields, gateBlockInstanceScript } = await import('./block-script-gate');
        const found = findBlock(loaded.blocks, String(input.block_id));
        const scriptWarnings = gateBlockInstanceScript(
          input.data as Record<string, unknown> | undefined,
          await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, found?.block.type),
          ctx.site,
        );
        const blocks = updateBlockMutation(loaded.blocks, {
          block_id: String(input.block_id),
          data: input.data as Record<string, unknown>,
        });
        await writeContainer(target, blocks, ctx, loaded.raw);
        return {
          result: { ok: true, ...(scriptWarnings.length ? { warnings: scriptWarnings } : {}) },
          action: containerAction(target, loaded, ctx, `Updated block ${input.block_id} on ${targetLabel(target, loaded)}.`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'move_block': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        const blocks = moveBlockMutation(loaded.blocks, {
          block_id: String(input.block_id),
          target_parent_id: input.target_parent_id as string | null | undefined,
          target_slot_index: input.target_slot_index as number | undefined,
          target_position: input.target_position as number | undefined,
        });
        await writeContainer(target, blocks, ctx, loaded.raw);
        return {
          result: { ok: true },
          action: containerAction(target, loaded, ctx, `Moved block ${input.block_id} on ${targetLabel(target, loaded)}.`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'remove_block': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        const blocks = removeBlockMutation(loaded.blocks, String(input.block_id));
        await writeContainer(target, blocks, ctx, loaded.raw);
        return {
          result: { ok: true },
          action: containerAction(target, loaded, ctx, `Removed block ${input.block_id} from ${targetLabel(target, loaded)}.`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'duplicate_block': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        const { tree, duplicate_id } = duplicateBlockMutation(loaded.blocks, String(input.block_id));
        await writeContainer(target, tree, ctx, loaded.raw);
        return {
          result: { ok: true, duplicate_id },
          action: containerAction(target, loaded, ctx, `Duplicated block ${input.block_id} on ${targetLabel(target, loaded)}.`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'set_block_responsive': {
      const target = normaliseTarget(input as { target?: { kind?: string; id?: string }; page_id?: string });
      if (!target) return { result: { error: 'Either target or page_id is required' } };
      try {
        const loaded = await loadContainer(target, ctx);
        // Third route into block.data, and it names the field directly —
        // refuse outright rather than silently dropping the whole call, since
        // a responsive value on a code field is never a legitimate ask.
        const { resolveScriptFields, aiScriptsEnabled, INSTANCE_SCRIPT_GATE_WARNING } =
          await import('./block-script-gate');
        const found = findBlock(loaded.blocks, String(input.block_id));
        const scriptFields = await resolveScriptFields(
          ctx.orgId, ctx.siteId, ctx.versionId, found?.block.type,
        );
        if (scriptFields.includes(String(input.field)) && !aiScriptsEnabled(ctx.site)) {
          return { result: { error: INSTANCE_SCRIPT_GATE_WARNING } };
        }
        const blocks = setBlockResponsiveField(loaded.blocks, {
          block_id: String(input.block_id),
          field: String(input.field),
          value: input.value,
        });
        await writeContainer(target, blocks, ctx, loaded.raw);
        return {
          result: { ok: true },
          action: containerAction(target, loaded, ctx, `Set ${input.field} responsive value on block ${input.block_id} (${targetLabel(target, loaded)}).`),
        };
      } catch (e) {
        if (e instanceof ContainerError) return { result: { error: e.message } };
        return { result: { error: e instanceof BlockMutationError ? e.message : String(e) } };
      }
    }

    case 'set_page_mode': {
      const pageId = String(input.page_id ?? '');
      const to = String(input.to ?? '');
      if (to !== 'blocks' && to !== 'html') {
        return { result: { error: 'to must be "blocks" or "html"' } };
      }
      const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
      if (!page) return { result: { error: 'Page not found' } };
      if (page.content_mode === to) {
        return { result: { ok: true, unchanged: true, content_mode: to } };
      }
      await snapshotRevision({
        orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId,
        kind: 'page', resourceIds: [pageId],
        doc: page as unknown as Record<string, unknown>,
        createdBy: 'chat',
        note: `Pre-mode-switch: ${page.content_mode} → ${to}`,
      });
      const update: Partial<Page> = { content_mode: to };
      let converted = false;
      if (to === 'blocks') {
        if (input.convert && page.html_content) {
          update.blocks = htmlToBlocks(page.html_content).blocks;
          converted = true;
        } else {
          update.blocks = page.blocks ?? [];
        }
      } else {
        update.blocks = [];
        update.html_content = page.html_content ?? '';
      }
      await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId, update);
      return {
        result: { ok: true, content_mode: to, converted },
        action: {
          type: 'update_page',
          description: `Switched ${page.title} to ${to}-mode.`,
          target: pageId,
          preview_url: absolutePreviewUrl(ctx, { slug: page.slug }),
        },
      };
    }

    case 'convert_page_to_blocks': {
      const pageId = String(input.page_id ?? '');
      const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
      if (!page) return { result: { error: 'Page not found' } };
      if (!page.html_content) {
        return { result: { blocks: [], notes: ['Page has no html_content to convert.'] } };
      }
      const result = htmlToBlocks(page.html_content);
      return { result };
    }

    case 'list_block_types': {
      // Returns core + custom block types in one list so the model
      // doesn't need to know about origin to discover what's usable.
      // Core types ship in code (origin: 'core'); custom/third-party
      // are persisted in the datastore. Output shape is the same
      // BlockType for both — id, label, category, container,
      // slot_count/slot_labels, schema (fields with name/type/label).
      // Use the schema to know what `data.X` fields each block accepts
      // when calling add_block.
      const custom = await store.listDocs<BlockType>(paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId));
      const merged: BlockType[] = [
        ...CORE_BLOCK_TYPES.filter((b) => b.id !== 'template_content_slot').map((b) => ({ ...b })),
        ...custom,
      ];
      // Trim the JSON payload — schema can be large for content-heavy
      // sites. The model can call read_block_type for the full detail.
      const slim = merged.map((b) => ({
        id: b.id,
        name: b.name,
        label: b.label,
        category: b.category,
        container: b.container,
        slot_count: b.slot_count,
        slot_labels: b.slot_labels,
        icon: b.icon,
        origin: b.origin ?? b.created_by ?? 'core',
        field_count: b.schema?.length ?? 0,
        field_names: b.schema?.map((f) => f.name) ?? [],
      }));
      return { result: slim };
    }

    case 'read_block_type': {
      const id = String(input.id ?? '');
      const fromCore = CORE_BLOCK_TYPES.find((b) => b.id === id);
      if (fromCore) return { result: fromCore };
      const doc = await store.getDoc<BlockType>(
        `${paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`,
      );
      if (!doc) return { result: { error: `Block type ${id} not found` } };
      return { result: doc };
    }

    case 'create_block_type': {
      const name = String(input.name ?? '');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
        return { result: { error: 'name must be lowercase kebab/underscore (1-64 chars)' } };
      }
      const id = name;
      const docPath = `${paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`;
      const existing = await store.getDoc(docPath);
      if (existing) {
        return { result: { error: `Block type "${id}" already exists. Use update_block_type to change it.` } };
      }
      // Whitelist input keys — never trust the model to honour the schema.
      // `script` is gated on the per-site opt-in (Site.ai_scripts_enabled,
      // human-set in the portal); without it the field is dropped and a
      // warning surfaces in the result.
      const { gateBlockScript } = await import('./block-script-gate');
      const siteDoc = await store.getDoc<Site>(paths.site(ctx.orgId, ctx.siteId));
      const scriptInput = { script: typeof input.script === 'string' ? input.script : undefined };
      const scriptWarnings = gateBlockScript(scriptInput, siteDoc ?? {});
      const doc: BlockType = {
        id,
        name,
        label: typeof input.label === 'string' ? input.label : name,
        icon: typeof input.icon === 'string' ? input.icon : undefined,
        category: ['layout', 'content', 'media', 'custom'].includes(String(input.category))
          ? (input.category as BlockType['category']) : 'custom',
        container: input.container as BlockType['container'] ?? false,
        slot_count: typeof input.slot_count === 'number' ? input.slot_count : undefined,
        slot_labels: Array.isArray(input.slot_labels) ? input.slot_labels as string[] : undefined,
        item_compatible: input.item_compatible === true ? true : undefined,
        expand_to: input.expand_to as BlockType['expand_to'],
        schema: Array.isArray(input.schema) ? input.schema as BlockType['schema'] : [],
        template: typeof input.template === 'string' ? input.template : undefined,
        styles: typeof input.styles === 'string' ? input.styles : undefined,
        script: scriptInput.script,
        origin: 'ai',
        created_at: new Date().toISOString(),
      };
      await store.setDoc(docPath, doc);
      return {
        result: { ok: true, block_type: doc, ...(scriptWarnings.length ? { warnings: scriptWarnings } : {}) },
        action: {
          type: 'update_settings',
          description: `Created custom block type "${id}".`,
          target: id,
        },
      };
    }

    case 'update_block_type': {
      const id = String(input.id ?? '');
      if (id.startsWith('core/')) {
        return { result: { error: 'Core block types are managed in platform code and cannot be edited via tool.' } };
      }
      const docPath = `${paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`;
      const existing = await store.getDoc<BlockType>(docPath);
      if (!existing) return { result: { error: `Block type ${id} not found` } };

      const patch: Partial<BlockType> = {};
      if (typeof input.label === 'string') patch.label = input.label;
      if (typeof input.icon === 'string') patch.icon = input.icon;
      if (['layout', 'content', 'media', 'custom'].includes(String(input.category))) {
        patch.category = input.category as BlockType['category'];
      }
      if (input.container !== undefined) patch.container = input.container as BlockType['container'];
      if (typeof input.slot_count === 'number') patch.slot_count = input.slot_count;
      if (Array.isArray(input.slot_labels)) patch.slot_labels = input.slot_labels as string[];
      if (typeof input.item_compatible === 'boolean') patch.item_compatible = input.item_compatible || undefined;
      if (input.expand_to !== undefined) patch.expand_to = input.expand_to as BlockType['expand_to'];
      if (Array.isArray(input.schema)) patch.schema = input.schema as BlockType['schema'];
      if (typeof input.template === 'string') patch.template = input.template;
      if (typeof input.styles === 'string') patch.styles = input.styles;
      // `script` is gated on the per-site opt-in — see create_block_type.
      const { gateBlockScript } = await import('./block-script-gate');
      const siteDoc = await store.getDoc<Site>(paths.site(ctx.orgId, ctx.siteId));
      const scriptInput = { script: typeof input.script === 'string' ? input.script : undefined };
      const scriptWarnings = gateBlockScript(scriptInput, siteDoc ?? {});
      if (scriptInput.script !== undefined) patch.script = scriptInput.script;

      const merged: BlockType = { ...existing, ...patch };
      await store.setDoc(docPath, merged);
      return {
        result: { ok: true, block_type: merged, ...(scriptWarnings.length ? { warnings: scriptWarnings } : {}) },
        action: {
          type: 'update_settings',
          description: `Updated block type "${id}".`,
          target: id,
        },
      };
    }

    case 'delete_block_type': {
      const id = String(input.id ?? '');
      if (id.startsWith('core/')) {
        return { result: { error: 'Core block types are managed in platform code and cannot be deleted.' } };
      }
      const docPath = `${paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`;
      const existing = await store.getDoc(docPath);
      if (!existing) return { result: { error: `Block type ${id} not found` } };
      await store.deleteDoc(docPath);
      return {
        result: { ok: true },
        action: {
          type: 'update_settings',
          description: `Deleted block type "${id}".`,
          target: id,
        },
      };
    }

    case 'list_page_templates': {
      const list = await store.listDocs(paths.pageTemplates(ctx.orgId, ctx.siteId, ctx.versionId));
      return { result: list };
    }

    case 'set_page_template': {
      const pageId = String(input.page_id ?? '');
      const templateId = input.template_id as string | null;
      const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
      if (!page) return { result: { error: 'Page not found' } };
      await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId, {
        template: templateId ?? undefined,
      });
      return {
        result: { ok: true, template: templateId },
        action: {
          type: 'update_page',
          description: templateId
            ? `Set ${page.title} to template "${templateId}".`
            : `Removed template from ${page.title}.`,
          target: pageId,
          preview_url: absolutePreviewUrl(ctx, { slug: page.slug }),
        },
      };
    }

    // ─── Global blocks (header / footer / free) ────────────────────────────
    case 'list_partials': {
      const list = await vstore.partials(ctx.orgId, ctx.siteId, ctx.versionId);
      return {
        result: list.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status })),
      };
    }

    case 'list_blocks_with_usage': {
      const [list, usage, pages] = await Promise.all([
        vstore.partials(ctx.orgId, ctx.siteId, ctx.versionId),
        getAllBlockUsage(ctx.orgId, ctx.siteId, ctx.versionId),
        vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId),
      ]);
      const totalPages = pages.length;
      return {
        result: list.map((p) => {
          const autoInjected = p.kind === 'header' || p.kind === 'footer';
          const usedOn = autoInjected ? totalPages : usage.get(p.id)?.length ?? 0;
          return {
            id: p.id,
            name: p.name,
            kind: p.kind,
            status: p.status,
            auto_injected: autoInjected,
            used_on_pages: usedOn,
          };
        }),
      };
    }

    case 'read_partial': {
      const id = String(input.partial_id);
      const doc = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id);
      if (!doc) return { result: { error: 'Partial not found' } };
      return {
        result: {
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          status: doc.status,
          html_content: doc.html_content ?? '',
        },
      };
    }

    case 'find_pages_using_block': {
      const partialId = String(input.partial_id ?? '').trim();
      if (!partialId) return { result: { error: 'partial_id required' } };
      // Header/footer are auto-injected on every page — they don't appear as
      // <x-include> in page HTML. Return the full page list so the model can
      // reason about blast radius the same way.
      if (partialId === 'header' || partialId === 'footer') {
        const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
        return {
          result: {
            partial_id: partialId,
            auto_injected: true,
            pages: pages.map((p) => ({ page_id: p.id, title: p.title, slug: p.slug })),
          },
        };
      }
      const matches = await getBlockUsage(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
      return {
        result: {
          partial_id: partialId,
          auto_injected: false,
          pages: matches.map((p) => ({ page_id: p.page_id, title: p.title, slug: p.slug })),
        },
      };
    }

    case 'update_partial': {
      const id = String(input.partial_id);
      // applyContentWrite performs the site-aware sanitizer pass so a custom
      // iframe allowlist is honored and sanitization warnings are preserved.
      const html = String(input.html_content ?? '');
      const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id);
      const inferKind = (): 'header' | 'footer' | 'free' => {
        if (input.kind === 'header' || input.kind === 'footer' || input.kind === 'free') return input.kind;
        if (id === 'header' || id === 'footer') return id;
        return 'free';
      };
      const fields: Record<string, unknown> = {
        html_content: html,
        // New partials keep the pre-buffer default (published) so a freshly
        // created header/footer renders in previews right away; existing
        // partials keep their status unless the input changes it.
        status: input.status
          ? String(input.status)
          : existing?.status ?? 'published',
      };
      if (!existing) {
        fields.name = input.name ? String(input.name) : id;
        fields.kind = inferKind();
      } else if (input.name) {
        fields.name = String(input.name);
      }
      await applyContentWrite(wcCtx(ctx), { kind: 'partial', id }, fields, { updatedBy: 'chat-ai' });
      return {
        result: { ok: true, partial_id: id, kind: existing?.kind ?? inferKind(), draft: true },
        action: {
          type: 'update_partial',
          description: existing
            ? `Updated the ${existing.kind ?? id} (unsaved draft).`
            : `Created the ${id} block (draft content — save to apply).`,
        },
      };
    }

    // ─── Design reference ──────────────────────────────────────────────────
    case 'read_design_notes': {
      return { result: { notes: DESIGN_NOTES_STARTER } };
    }

    case 'read_playbook': {
      return { result: { playbook: PLAYBOOK_STARTER } };
    }

    // ─── Site settings ─────────────────────────────────────────────────────
    case 'read_site_settings': {
      const s = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
      return { result: s ?? {} };
    }

    case 'update_site_settings': {
      // Explicit whitelist. Scripts and custom CSS are deliberately NOT
      // updatable from the chat — they're scriptable surfaces and require
      // user action in /app/sites/{id}/settings.
      const SAFE_TOP_LEVEL = new Set(['site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'default_seo_suffix', 'default_meta_description', 'image_sizes_default']);
      const SAFE_NESTED = new Set(['colors', 'fonts', 'contact', 'social']);

      const existing = ((await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {}) as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (v === undefined) continue;
        if (SAFE_NESTED.has(k)) {
          const before = (existing[k] as Record<string, unknown> | undefined) ?? {};
          update[k] = { ...before, ...(v as Record<string, unknown>) };
        } else if (SAFE_TOP_LEVEL.has(k)) {
          update[k] = v;
        }
        // Anything else (scripts_head, custom_css, cookie_consent, etc.) is
      // silently dropped — these are scriptable surfaces and must require
      // human admin action via the settings UI.
      }
      await vstore.writeSettings(ctx.orgId, ctx.siteId, ctx.versionId, update as Partial<SiteSettings>);
      return {
        result: { ok: true },
        action: { type: 'update_site_settings', description: 'Updated site settings.' },
      };
    }

    // ─── Collections ───────────────────────────────────────────────────────
    case 'list_collections': {
      const colls = await vstore.collections(ctx.orgId, ctx.siteId, ctx.versionId);
      return {
        result: colls.map((c) => ({
          name: c.name,
          label_singular: c.label_singular,
          label_plural: c.label_plural,
          icon: c.icon,
          fields: c.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, required: f.required })),
        })),
      };
    }

    case 'list_collection_items': {
      const collection = String(input.collection);
      const items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, collection);
      const status = (input.status as string) || 'all';
      let filtered = status === 'all' ? items : items.filter((it) => it.status === status);
      if (typeof input.limit === 'number') filtered = filtered.slice(0, input.limit);
      return {
        result: filtered.map((it) => it),
      };
    }

    case 'read_collection_item': {
      const collection = String(input.collection);
      const itemId = String(input.item_id);
      const item = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, collection, itemId);
      if (!item) return { result: { error: 'Item not found' } };
      return { result: item };
    }

    case 'create_collection_item': {
      const collection = String(input.collection);
      const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, collection);
      if (!coll) return { result: { error: `Collection "${collection}" not found` } };
      const fields = (input.fields ?? {}) as Record<string, unknown>;
      const status = (input.status as 'draft' | 'published') ?? 'draft';
      const now = new Date().toISOString();
      const allowed = new Set(coll.fields.map((f) => f.name));
      const item: Record<string, unknown> = { status, created_at: now, updated_at: now };
      for (const [k, v] of Object.entries(fields)) if (allowed.has(k)) item[k] = v;

      const itemId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await store.setDoc(paths.collectionItem(ctx.orgId, ctx.siteId, collection, itemId, ctx.versionId), item);
      return {
        result: { ok: true, item_id: itemId },
        action: {
          type: 'create_collection_item',
          description: `Added a ${coll.label_singular.toLowerCase()} to ${coll.label_plural} (${status}).`,
        },
      };
    }

    case 'update_collection_item': {
      const collection = String(input.collection);
      const itemId = String(input.item_id);
      const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, collection);
      if (!coll) return { result: { error: `Collection "${collection}" not found` } };
      const existing = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, collection, itemId);
      if (!existing) return { result: { error: 'Item not found' } };

      const update: Record<string, unknown> = { ...((input.fields ?? {}) as Record<string, unknown>) };
      if (input.status !== undefined) update.status = input.status;

      await applyContentWrite(
        wcCtx(ctx), { kind: 'item', collection, id: itemId }, update, { updatedBy: 'chat-ai' },
      );
      return {
        result: { ok: true, draft: true },
        action: {
          type: 'update_collection_item',
          description: `Updated a ${coll.label_singular.toLowerCase()} (unsaved draft).`,
        },
      };
    }

    case 'delete_collection_item': {
      const collection = String(input.collection);
      const itemId = String(input.item_id);
      await vstore.deleteCollectionItem(ctx.orgId, ctx.siteId, ctx.versionId, collection, itemId);
      return { result: { ok: true }, action: { type: 'delete_collection_item', description: `Deleted an item from ${collection}.` } };
    }

    // ─── Media ─────────────────────────────────────────────────────────────
    case 'list_media': {
      const items = await store.listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
      items.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      const limit = typeof input.limit === 'number' ? input.limit : 50;
      return {
        result: items.slice(0, limit).map((m) => ({
          id: m.id,
          filename: m.filename,
          cdn_url: m.cdn_url,
          alt_text: m.alt_text,
          width: m.width,
          height: m.height,
          mime_type: m.mime_type,
        })),
      };
    }

    // ─── Redirects ─────────────────────────────────────────────────────────
    case 'list_redirects': {
      const items = await vstore.redirects(ctx.orgId, ctx.siteId, ctx.versionId);
      return { result: items.map((r) => ({ id: r.id, from_path: r.from_path, to_path: r.to_path, status_code: r.status_code })) };
    }

    case 'create_redirect': {
      const from_path = String(input.from_path);
      const to_path = String(input.to_path);
      const status_code = (input.status_code === 302 ? 302 : 301) as 301 | 302;
      const check = await checkRedirectWrite({
        orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, from_path, to_path,
      });
      if (!check.ok) return { result: { error: check.error } };
      const id = redirectDocId(from_path);
      await store.setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`, {
        from_path,
        to_path,
        status_code,
        auto_generated: false,
      });
      return {
        result: { ok: true, id },
        action: { type: 'create_redirect', description: `Added redirect ${from_path} → ${to_path}.` },
      };
    }

    // ─── Forms ─────────────────────────────────────────────────────────────
    case 'list_forms': {
      const list = await store.listDocs(paths.forms(ctx.orgId, ctx.siteId));
      return {
        result: list.map((f) => {
          const form = f as { id: string; name?: string; fields?: Array<{ name: string; label: string; type: string }> };
          return {
            id: form.id,
            name: form.name,
            fields: (form.fields ?? []).map((field) => ({ name: field.name, label: field.label, type: field.type })),
          };
        }),
      };
    }

    case 'get_form_embed': {
      const formId = String(input.form_id);
      const { signFormToken, isFormsSigningConfigured } = await import('./forms-signing');
      if (!isFormsSigningConfigured()) {
        return { result: { error: 'FORMS_HMAC_SECRET is not configured; cannot mint a token.' } };
      }
      const { buildFormEmbedDirective } = await import('./forms-admin');
      const form = await store.getDoc<import('@typeroll/shared').Form>(
        `${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`
      );
      if (!form) return { result: { error: 'Form not found' } };

      const apiBase = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
      const token = signFormToken(ctx.orgId, ctx.siteId, formId);
      const submitUrl = `${apiBase}/api/forms/submit`;

      const snippet = buildFormEmbedDirective(formId);
      return {
        result: { token, submit_url: submitUrl, snippet, snippet_kind: 'server_rendered_directive' },
      };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}
