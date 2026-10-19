// Block data keys that no field of the block type declares.
//
// `update_block data: { placeholder_background: "#eee" }` on a core/repeater
// answered 200, stored the key at the repeater's top level and changed
// nothing: the colour is a field of the item block (core/post_card) and
// belongs in `item_overrides`. A caller cannot tell an inert key from a
// working one by reading the response.
//
// The known keys of a block type are what the renderer can read from its
// data:
//
// - the type's schema fields, plus those of every type it expands to
//   (`expand_to`), with the alias defaults;
// - keys the renderer reads from every block whether or not a schema declares
//   them (`UNDECLARED_BLOCK_DATA_KEYS`);
// - for a site block type, the names its templates and composition read
//   (`{{name}}`, `{{#each name}}`, `{{props.name}}`): a template may use a
//   value its schema leaves undeclared, and the renderer passes it through;
// - for a conditional container, the block-data names its condition reads.
//
// Extension block types are not checked: the renderer hands their whole data
// to the extension's component, which may read any key.
//
// Single-block writes (add_block, update_block) reject unknown keys; tree
// writes report them as `unknown_field` warnings so bulk writes keep landing
// (block-tree-warnings.ts).

import { STYLE_OVERRIDE_KEYS, type Block, type BlockType } from './types.js';

/**
 * Keys the renderer reads from the data of any block, declared or not.
 * Core types declare `responsive_breakpoints` in their schema; a site block
 * type does not have to, and the renderer still uses it for that block's
 * visibility rules and responsive CSS (render-blocks.ts).
 */
export const UNDECLARED_BLOCK_DATA_KEYS: Readonly<Record<string, string>> = {
  responsive_breakpoints: 'Per-block viewport widths: read on every block for hidden_on rules and responsive CSS, declared or not.',
};

/** Token roots that name render context, never block data. */
const CONTEXT_ROOTS = new Set(['page', 'site', 'item', 'props', 'content_type', 'collection', 'children']);
/** `{{name}}`, `{{{name}}}`, `{{=name}}`, `{{#name}}`, `{{^name}}`, `{{#each name}}`, `{{#link name …}}`. */
const TEMPLATE_TOKEN = /\{\{\{?\s*(?:[#^=]\s*)?(?:(?:each|link)\s+)?([A-Za-z_][\w.-]*)/g;
const PROPS_REFERENCE = /\bprops\.([A-Za-z_]\w*)/g;
const CONDITION_NAME = /(?:^|[^\w.@'"-])([A-Za-z_][\w-]*)(?:\.[\w.-]+)?/g;

export interface UnknownFieldIssue {
  code: 'unknown_field';
  block_id?: string;
  block_type: string;
  /** Path to the key, e.g. `data.placeholder_background` or `blocks[0].data.foo`. */
  path: string;
  key: string;
  /** Where the value probably belongs, e.g. `item_overrides.placeholder_background`. */
  suggestions: string[];
  message: string;
}

type Registry = ReadonlyMap<string, BlockType>;

/** The type a block renders as after following `expand_to`, with the alias chain's defaults. */
function resolveAlias(type: BlockType, registry: Registry): { types: BlockType[]; defaults: Record<string, unknown> } {
  const types = [type];
  let defaults: Record<string, unknown> = {};
  let current: BlockType | undefined = type;
  for (let depth = 0; current?.expand_to && depth < 5; depth++) {
    defaults = { ...current.expand_to.defaults, ...defaults };
    current = registry.get(current.expand_to.target);
    if (current) types.push(current);
  }
  return { types, defaults };
}

function templateNames(type: BlockType, out: Set<string>): void {
  const sources = [type.template ?? '', ...(type.render_versions ?? []).map(version => version.template ?? '')];
  for (const source of sources) {
    for (const match of source.matchAll(TEMPLATE_TOKEN)) {
      const root = match[1]!.split('.')[0]!;
      if (!CONTEXT_ROOTS.has(root)) out.add(root);
    }
  }
  if (type.composition?.length) {
    for (const match of JSON.stringify(type.composition).matchAll(PROPS_REFERENCE)) out.add(match[1]!);
  }
}

function conditionNames(condition: unknown, out: Set<string>): void {
  if (typeof condition !== 'string') return;
  // Quoted literals are values, not names.
  const names = condition.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const match of names.matchAll(CONDITION_NAME)) {
    const root = match[1]!;
    if (!CONTEXT_ROOTS.has(root)) out.add(root);
  }
}

/**
 * Every data key the renderer can read for a block of `type`, or null when
 * the type is not checked (an extension block). `data` is the block's data,
 * used for names a conditional container's condition reads.
 */
export function knownBlockDataKeys(type: BlockType, registry: Registry, data?: Record<string, unknown>): Set<string> | null {
  const { types, defaults } = resolveAlias(type, registry);
  if (types.some(candidate => candidate.extension)) return null;
  const known = new Set<string>(Object.keys(UNDECLARED_BLOCK_DATA_KEYS));
  for (const key of Object.keys(defaults)) known.add(key);
  for (const candidate of types) {
    for (const field of candidate.schema ?? []) known.add(field.name);
    if (candidate.origin !== 'core') templateNames(candidate, known);
    if (candidate.container === 'conditional') conditionNames(data?.condition, known);
  }
  return known;
}

/** The item block a repeater (or an alias of one) renders each item with. */
function repeaterItemType(type: BlockType, registry: Registry, data: Record<string, unknown>): BlockType | undefined {
  const { types, defaults } = resolveAlias(type, registry);
  if (types[types.length - 1]?.container !== 'repeater') return undefined;
  const itemId = data.item_block ?? defaults.item_block;
  return typeof itemId === 'string' && itemId ? registry.get(itemId) : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Up to three declared names that look like `key`: small edit distance or one containing the other. */
export function closestFieldNames(key: string, names: Iterable<string>): string[] {
  const lower = key.toLowerCase();
  const limit = Math.max(2, Math.floor(lower.length / 3));
  return [...new Set(names)]
    .map(name => {
      const distance = editDistance(lower, name.toLowerCase());
      const contains = lower.length >= 3 && name.length >= 3 && (name.includes(lower) || lower.includes(name));
      return { name, score: distance <= limit ? distance : contains ? limit + 1 : Infinity };
    })
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(candidate => candidate.name);
}

/**
 * Unknown keys in one block's own data. `keys` limits the check to the keys
 * a write set (update_block); by default every key is checked. `data` is the
 * block's data after the write, so a repeater's item block resolves from the
 * stored `item_block` as well as from the write.
 */
export function unknownBlockDataFields(
  block: { id?: unknown; type: string; data?: unknown },
  registry: Registry,
  options: { path?: string; keys?: Iterable<string> } = {},
): UnknownFieldIssue[] {
  const type = registry.get(block.type);
  const data = block.data && typeof block.data === 'object' && !Array.isArray(block.data) ? block.data as Record<string, unknown> : {};
  if (!type) return [];
  const known = knownBlockDataKeys(type, registry, data);
  if (!known) return [];
  const path = options.path ?? 'data';
  const blockId = typeof block.id === 'string' && block.id ? block.id : undefined;
  const issues: UnknownFieldIssue[] = [];
  let itemType: BlockType | undefined | null = null;
  for (const key of options.keys ?? Object.keys(data)) {
    if (known.has(key)) continue;
    itemType = itemType === null ? repeaterItemType(type, registry, data) : itemType;
    const itemKnown = itemType ? knownBlockDataKeys(itemType, registry) : null;
    let suggestions: string[];
    let message: string;
    if (itemType && itemKnown?.has(key) && !Object.hasOwn(UNDECLARED_BLOCK_DATA_KEYS, key)) {
      suggestions = [`item_overrides.${key}`];
      message = `${path}.${key} is not a field of ${type.id}; it is a field of the item block ${itemType.id}. Did you mean item_overrides.${key}?`;
    } else if ((STYLE_OVERRIDE_KEYS as readonly string[]).includes(key)) {
      suggestions = [`style_overrides.${key}`];
      message = `${path}.${key} is not a field of ${type.id}. Did you mean style_overrides.${key}?`;
    } else {
      suggestions = closestFieldNames(key, [...known].filter(name => !Object.hasOwn(UNDECLARED_BLOCK_DATA_KEYS, name)));
      message = `${path}.${key} is not a field of ${type.id}${suggestions.length ? `. Did you mean ${suggestions.join(', ')}?` : '. read_block_type lists its fields.'}`;
    }
    issues.push({
      code: 'unknown_field',
      ...(blockId ? { block_id: blockId } : {}),
      block_type: type.id,
      path: `${path}.${key}`,
      key,
      suggestions,
      message: `${message} The key would be stored and never rendered.`,
    });
  }
  return issues;
}

/** Unknown data keys in a block and everything inside it (children and slots). */
export function unknownBlockFields(block: unknown, registry: Registry, path = 'block'): UnknownFieldIssue[] {
  const out: UnknownFieldIssue[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, at: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) return;
    seen.add(node);
    const typed = node as Block;
    if (typeof typed.type === 'string') out.push(...unknownBlockDataFields(typed, registry, { path: `${at}.data` }));
    if (Array.isArray(typed.children)) typed.children.forEach((child, index) => visit(child, `${at}.children[${index}]`));
    if (Array.isArray(typed.slots)) typed.slots.forEach((slot, s) => Array.isArray(slot) && slot.forEach((child, index) => visit(child, `${at}.slots[${s}][${index}]`)));
  };
  visit(block, path);
  return out;
}

/** Unknown data keys anywhere in a block tree. Unknown block types are skipped. */
export function unknownTreeFields(value: unknown, registry: Registry, root = 'blocks'): UnknownFieldIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block, index) => unknownBlockFields(block, registry, `${root}[${index}]`));
}
