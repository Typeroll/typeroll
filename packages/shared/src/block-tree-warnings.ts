// Write-time warnings: things a caller got wrong that the platform would
// otherwise store, return and build without comment.
//
// `style_overrides: { class: 'x' }` answers 200 with saved: true, stores the
// key, survives the build, survives the deploy, and never reaches the markup —
// because the renderer reads `custom_class`. The only way to find out is to
// measure a rendered pixel. That is a correct-looking success hiding a wrong
// underlying state, and it is the one variety of that the platform can remove
// by itself rather than waiting for someone to notice.
//
// WARNINGS, NOT ERRORS. A write that is mostly right should still land: the
// caller has already lost the round trip, and rejecting the whole tree over one
// misspelled key would cost more than it saves. But the report has to travel in
// the response body, because a caller driving the API cannot read our logs, and
// a warning nobody receives is the same as no warning.

import { STYLE_OVERRIDE_KEYS, type BlockType } from './types.js';
import { blockFieldTypeWarnings } from './block-field-types.js';
import { unknownItemFields, unknownTreeFields } from './block-unknown-fields.js';
import { buildCoreBlockRegistry } from './core-blocks.js';

let coreRegistry: Map<string, BlockType> | undefined;

export interface BlockTreeWarning {
  /**
   * `unknown_style`, `style_target_mismatch` and `part_style_contrast` concern a
   * block's `part_styles` and need the site's styles (block-parts.ts
   * `partStyleIssues`); the portal adds them to tree writes.
   */
  code: 'ineffective_whole_card_link' | 'unknown_style_override' | 'heading_part_as_text' | 'field_type_mismatch' | 'unknown_field' | 'unknown_style' | 'style_target_mismatch' | 'part_style_contrast';
  /** The block's id where it has one; a tree may be written before ids exist. */
  block_id?: string;
  /** Path to the offending key, e.g. `blocks[0].style_overrides.class`. */
  path: string;
  /** The key that will be stored and never read (unknown_style_override, unknown_field). */
  key?: string;
  /** The block's type (unknown_field). */
  block_type?: string;
  /** Where the key probably belongs (unknown_field), e.g. `item_overrides.placeholder_background`; styles that fit a part (unknown_style, style_target_mismatch). */
  suggestions?: string[];
  /** The schema field and the type it needs (field_type_mismatch). */
  field?: string;
  expected?: string;
  message: string;
}

/**
 * Unknown `style_overrides` keys anywhere in a block tree.
 *
 * The renderer enumerates the override keys in one place, so an unknown key
 * there is certainly inert. A block's `data` key that no field of its type
 * (or the type it expands to) declares and the renderer does not read is
 * reported as `unknown_field`, with where it probably belongs
 * (block-unknown-fields.ts); a known field whose value has the wrong type is
 * `field_type_mismatch`. Core block types are always known; pass `registry`
 * to include site block types. Blocks of a type the registry does not know
 * are not checked.
 */
export function blockTreeWarnings(value: unknown, root = 'blocks', registry?: ReadonlyMap<string, BlockType>): BlockTreeWarning[] {
  const known = new Set<string>(STYLE_OVERRIDE_KEYS);
  const warnings: BlockTreeWarning[] = [];
  const seen = new Set<object>();
  const typed: [{ type: string }, string][] = [];

  const visit = (node: unknown, path: string) => {
    if (!Array.isArray(node)) return;
    node.forEach((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return;
      if (seen.has(block)) return;
      seen.add(block);
      const at = `${path}[${index}]`;
      const overrides = (block as { style_overrides?: unknown }).style_overrides;
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const key of Object.keys(overrides)) {
          if (known.has(key)) continue;
          const id = (block as { id?: unknown }).id;
          warnings.push({
            code: 'unknown_style_override',
            ...(typeof id === 'string' && id ? { block_id: id } : {}),
            path: `${at}.style_overrides.${key}`,
            key,
            message: `style_overrides.${key} is not a style override and will never be applied. Supported keys: ${STYLE_OVERRIDE_KEYS.join(', ')}.`,
          });
        }
      }
      const next = node[index + 1] as { type?: unknown } | undefined;
      const label = headingLabelHtml(block as { type?: unknown; data?: { html?: unknown } });
      if (label && next && typeof next === 'object' && (next.type === 'core/heading' || next.type === 'core/rich_heading')) {
        const id = (block as { id?: unknown }).id;
        warnings.push({
          code: 'heading_part_as_text',
          ...(typeof id === 'string' && id ? { block_id: id } : {}),
          path: at,
          message: `This text block only holds the label "${label}" above a heading. Put it in the heading block's eyebrow field and give it a named style instead of classed HTML.`,
        });
      }
      warnings.push(...blockBehaviorWarnings(block as { id?: string; type?: string; data?: Record<string, unknown> }, at));
      if (typeof (block as { type?: unknown }).type === 'string') typed.push([block as { type: string }, at]);
      const children = (block as { children?: unknown }).children;
      if (children !== undefined) visit(children, `${at}.children`);
      const slots = (block as { slots?: unknown }).slots;
      if (Array.isArray(slots)) slots.forEach((slot, s) => visit(slot, `${at}.slots[${s}]`));
    });
  };

  visit(value, root);
  const types = registry ?? (coreRegistry ??= buildCoreBlockRegistry());
  warnings.push(...unknownTreeFields(value, types, root));
  for (const [block, at] of typed) warnings.push(...unknownItemFields(block, types, { path: `${at}.data` }));
  warnings.push(...blockFieldTypeWarnings(value, types, root));
  return warnings;
}

/** The text of a prose block that is just one short, classed label element. */
function headingLabelHtml(block: { type?: unknown; data?: { html?: unknown } }): string | null {
  if (block.type !== 'core/prose' || typeof block.data?.html !== 'string') return null;
  const match = block.data.html.trim().match(/^<(p|span|div|small|strong)\b[^>]*\bclass="[^"]+"[^>]*>([^<]{1,80})<\/\1>$/i);
  return match ? match[2].trim() || null : null;
}

/**
 * The same check for a single-block write.
 *
 * The tree walker covers page and partial writes, which is where it was first
 * wired in. But the discovery path for this defect was a one-block PATCH —
 * `style_overrides: { class: "moveria-home" }` on a block id — and those routes
 * take the overrides directly, never as a tree, so the warning never reached
 * the route where the mistake is easiest to make.
 *
 * The path names the block rather than an index, because there is no tree for
 * an index to mean anything in.
 */
export function styleOverrideWarnings(
  styleOverrides: unknown,
  blockId?: string,
): BlockTreeWarning[] {
  if (!styleOverrides || typeof styleOverrides !== 'object' || Array.isArray(styleOverrides)) return [];
  const known = new Set<string>(STYLE_OVERRIDE_KEYS);
  return Object.keys(styleOverrides)
    .filter((key) => !known.has(key))
    .map((key) => ({
      code: 'unknown_style_override' as const,
      ...(blockId ? { block_id: blockId } : {}),
      path: `${blockId ?? 'block'}.style_overrides.${key}`,
      key,
      message: `style_overrides.${key} is not a style override and will never be applied. Supported keys: ${STYLE_OVERRIDE_KEYS.join(', ')}.`,
    }));
}


/** Conflicting presentation choices are reported without discarding content. */
export function blockBehaviorWarnings(block: { id?: string; type?: string; data?: Record<string, unknown> }, path = 'block'): BlockTreeWarning[] {
  const data = block.data ?? {};
  const check = (value: Record<string, unknown>, at: string): BlockTreeWarning[] =>
    value.whole_card_link === true && (String(value.action_label ?? '').trim() || String(value.download_url_field ?? '').trim() || value.title_link === false)
      ? [{ code: 'ineffective_whole_card_link', block_id: block.id, block_type: block.type, path: `${at}.whole_card_link`,
        message: 'The whole-card link needs a linked title and no secondary actions. Remove action_label/download_url_field and enable title_link, or disable whole_card_link and keep separate links.' }] : [];
  if (block.type === 'core/post_card') return check(data, `${path}.data`);
  if ((block.type === 'core/page_list' || block.type === 'core/repeater') && (!data.item_block || data.item_block === 'core/post_card')) {
    return check((data.item_overrides ?? {}) as Record<string, unknown>, `${path}.data.item_overrides`);
  }
  return [];
}
