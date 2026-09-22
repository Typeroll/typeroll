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

import { STYLE_OVERRIDE_KEYS } from './types.js';

export interface BlockTreeWarning {
  code: 'unknown_style_override';
  /** The block's id where it has one; a tree may be written before ids exist. */
  block_id?: string;
  /** Path to the offending key, e.g. `blocks[0].style_overrides.class`. */
  path: string;
  /** The key that will be stored and never read. */
  key: string;
  message: string;
}

/**
 * Unknown `style_overrides` keys anywhere in a block tree.
 *
 * Only this set is checked, because only this set is closed: the renderer
 * enumerates it in one place, so an unknown key here is certainly inert. A
 * block type's `data` is deliberately not checked the same way — its fields
 * vary per type and forward compatibility there is worth more than strictness.
 */
export function blockTreeWarnings(value: unknown, root = 'blocks'): BlockTreeWarning[] {
  const known = new Set<string>(STYLE_OVERRIDE_KEYS);
  const warnings: BlockTreeWarning[] = [];
  const seen = new Set<object>();

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
      const children = (block as { children?: unknown }).children;
      if (children !== undefined) visit(children, `${at}.children`);
      const slots = (block as { slots?: unknown }).slots;
      if (Array.isArray(slots)) slots.forEach((slot, s) => visit(slot, `${at}.slots[${s}]`));
    });
  };

  visit(value, root);
  return warnings;
}
