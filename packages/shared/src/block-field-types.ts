import { tokenScale, scaleValue, validColor, FONT_ROLES } from './design-tokens.js';
// Field values whose type does not match the block type's schema.
//
// `active_font_weight: "600"` on core/tabs was stored, returned and built
// without comment, and never rendered: the renderer only emits a number field
// whose value is a number. A caller cannot tell that from any response.
//
// Two halves, so neither depends on every write route remembering the other:
//
// - `coerceFieldValue` runs in the renderer. A string that is exactly a number
//   renders as that number, however the value reached the document (API, MCP,
//   editor, import, an older Core). Booleans are not converted: a switch such
//   as `new_tab` is on only for `true`, never for the text "true".
// - `blockFieldTypeWarnings` reports, at write time, values that will still not
//   render after that, with the field's path. Warnings, not errors, for the
//   same reason as the other block-tree warnings (block-tree-warnings.ts).

import { BREAKPOINT_ORDER, isResponsiveValue } from './breakpoints.js';
import { STYLE_ID_PATTERN } from './site-styles.js';
import type { Block, BlockType, FieldDefinition } from './types.js';

const NUMBER_TEXT = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/;

function coerceScalar(field: FieldDefinition, value: unknown): unknown {
  if (/(?:^|_)(?:font|font_family)$/.test(field.name) && value && !(FONT_ROLES as readonly unknown[]).includes(value)) return '';
  if (field.type === 'number' && typeof value === 'string' && NUMBER_TEXT.test(value)) return Number(value);
  return value;
}

/** The value the renderer uses for a field: numeric text converted, everything else unchanged. */
export function coerceFieldValue(field: FieldDefinition, value: unknown): unknown {
  if (field.responsive && isResponsiveValue(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const point of BREAKPOINT_ORDER) if (point in out) out[point] = coerceScalar(field, out[point]);
    return out;
  }
  return coerceScalar(field, value);
}

export interface FieldTypeWarning {
  code: 'field_type_mismatch';
  block_id?: string;
  /** Path to the value, e.g. `blocks[0].data.active_font_weight.desktop`. */
  path: string;
  field: string;
  expected: string;
  message: string;
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text && text.length > 60 ? `${text.slice(0, 57)}...` : String(text);
}

function scalarProblem(field: FieldDefinition, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (/(?:^|_)(?:font|font_family)$/.test(field.name)) return (FONT_ROLES as readonly unknown[]).includes(value) ? null : 'heading, body, mono or inherit';
  const scale = tokenScale(field);
  if (scale && scaleValue(scale, value)) return null;
  const coerced = coerceScalar(field, value);
  switch (field.type) {
    case 'color':
      if (typeof value === 'string' && /^\{\{\s*[a-zA-Z_][\w.]*\s*\}\}$/.test(value)) return null;
      return validColor(value) ? null : 'a palette name, palette CSS variable, color-mix or explicit CSS colour';
    case 'number':
      return typeof coerced === 'number' && Number.isFinite(coerced) ? null : 'a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true or false (a boolean, not text)';
    case 'select':
      if (!field.options?.length) return null;
      return (typeof value === 'string' || typeof value === 'number') && field.options.includes(String(value))
        ? null : `one of ${field.options.map(option => JSON.stringify(option)).join(', ')}`;
    default:
      return null;
  }
}

function fieldWarnings(
  fields: readonly FieldDefinition[],
  data: Record<string, unknown>,
  path: string,
  blockId: string | undefined,
  out: FieldTypeWarning[],
  depth: number,
): void {
  if (depth > 4) return;
  for (const field of fields) {
    if (!Object.hasOwn(data, field.name)) continue;
    const value = data[field.name];
    const at = `${path}.${field.name}`;
    if (field.type === 'object' && field.fields?.length && value && typeof value === 'object' && !Array.isArray(value)) {
      fieldWarnings(field.fields, value as Record<string, unknown>, at, blockId, out, depth + 1);
      continue;
    }
    if (field.type === 'array' && field.fields?.length) {
      if (!Array.isArray(value)) continue;
      value.forEach((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          fieldWarnings(field.fields!, item as Record<string, unknown>, `${at}[${index}]`, blockId, out, depth + 1);
        }
      });
      continue;
    }
    if (field.type === 'part_styles') {
      partStylesWarnings(field, value, at, blockId, out);
      continue;
    }
    const entries: Array<[string, unknown]> = field.responsive && isResponsiveValue(value)
      ? BREAKPOINT_ORDER.filter(point => point in (value as object)).map(point => [`${at}.${point}`, (value as Record<string, unknown>)[point]])
      : [[at, value]];
    for (const [valuePath, entry] of entries) {
      const expected = scalarProblem(field, entry);
      if (!expected) continue;
      out.push({
        code: 'field_type_mismatch',
        ...(blockId ? { block_id: blockId } : {}),
        path: valuePath,
        field: field.name,
        expected,
        message: `${valuePath} is ${describe(entry)}, but ${field.name} must be ${expected}. The value is stored and will not render.`,
      });
    }
  }
}

/** `part_styles` is an object of part names to style ids (block-parts.ts); unknown part names are `unknown_field`. */
function partStylesWarnings(field: FieldDefinition, value: unknown, at: string, blockId: string | undefined, out: FieldTypeWarning[]): void {
  if (value === undefined || value === null) return;
  const push = (path: string, entry: unknown, expected: string) => out.push({
    code: 'field_type_mismatch',
    ...(blockId ? { block_id: blockId } : {}),
    path, field: field.name, expected,
    message: `${path} is ${describe(entry)}, but ${path === at ? field.name : 'a part style'} must be ${expected}. The value is stored and will not render.`,
  });
  if (typeof value !== 'object' || Array.isArray(value)) { push(at, value, 'an object of part names to style ids, e.g. { "link": "quiet-link" }'); return; }
  for (const [part, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id !== 'string' || !STYLE_ID_PATTERN.test(id)) push(`${at}.${part}`, id, 'a style id (list_styles)');
  }
}

/** Item overrides and static rows use the selected item block's real schema. */
export function blockDataSchema(type: BlockType, data: Record<string, unknown>, registry: ReadonlyMap<string, BlockType>): FieldDefinition[] {
  let effective = type, values = data;
  const seen = new Set<string>();
  while (effective.expand_to && !seen.has(effective.id)) {
    seen.add(effective.id);
    values = { ...effective.expand_to.defaults, ...values };
    const next = registry.get(effective.expand_to.target);
    if (!next) break;
    effective = next;
  }
  if (effective.container !== 'repeater') return type.schema ?? [];
  const item = registry.get(String(values.item_block ?? effective.schema?.find(f => f.name === 'item_block')?.default ?? ''));
  if (!item) return type.schema ?? [];
  return (type.schema ?? []).map(field => ['item_overrides','items'].includes(field.name)
    ? { ...field, fields: item.schema } : field);
}

/** Type mismatches in one block's own `data` (not its children). */
export function blockDataTypeWarnings(
  block: Pick<Block, 'type' | 'data'> & { id?: unknown },
  registry: ReadonlyMap<string, BlockType>,
  path = 'block',
): FieldTypeWarning[] {
  const type = registry.get(block.type);
  if (!type?.schema || !block.data || typeof block.data !== 'object') return [];
  const out: FieldTypeWarning[] = [];
  const blockId = typeof block.id === 'string' && block.id ? block.id : undefined;
  fieldWarnings(blockDataSchema(type, block.data as Record<string, unknown>, registry), block.data as Record<string, unknown>, `${path}.data`, blockId, out, 0);
  return out;
}

/** Type mismatches anywhere in a block tree. Unknown block types are skipped. */
export function blockFieldTypeWarnings(
  value: unknown,
  registry: ReadonlyMap<string, BlockType>,
  root = 'blocks',
): FieldTypeWarning[] {
  const out: FieldTypeWarning[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, path: string) => {
    if (!Array.isArray(node)) return;
    node.forEach((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block) || seen.has(block)) return;
      seen.add(block);
      const at = `${path}[${index}]`;
      const typed = block as Block;
      if (typeof typed.type === 'string') out.push(...blockDataTypeWarnings(typed, registry, at));
      if (typed.children !== undefined) visit(typed.children, `${at}.children`);
      if (Array.isArray(typed.slots)) typed.slots.forEach((slot, s) => visit(slot, `${at}.slots[${s}]`));
    });
  };
  visit(value, root);
  return out;
}
