// Logic behind the block type builder and the page editor's "Turn into block
// type…" and "Detach" actions. Pure and browser-safe, so the components stay
// thin and the rules are unit tested.
//
// A composed block type is a tree of existing blocks (its composition) plus
// its own fields (props). Inner blocks read props through whole-value
// bindings: `{{props.title}}`, or `{{item.title}}` inside a repeater that
// loops over an array prop. See packages/shared/src/composed-blocks.ts.

import {
  BLOCK_TYPE_WRITABLE,
  deriveFieldValues,
  withFieldDefaults,
  type Block,
  type BlockType,
  type FieldDefinition,
  type FieldType,
  type PageUrlResolver,
} from '@typeroll/shared';
import { newBlockId, withFreshIds } from './block-tree-ops';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// ─── Bindings ────────────────────────────────────────────────────────────

const BINDING = /^\s*\{\{\s*((props|item)\.[\w.-]+)\s*\}\}\s*$/;

export interface ParsedBinding {
  namespace: 'props' | 'item';
  /** Field path below the namespace, e.g. ['link', 'href']. */
  path: string[];
}

/** A whole-value `{{props.x}}` / `{{item.x}}` binding, or null. */
export function parseBinding(value: unknown): ParsedBinding | null {
  if (typeof value !== 'string') return null;
  const match = BINDING.exec(value);
  if (!match) return null;
  const [namespace, ...path] = match[1]!.split('.');
  return { namespace: namespace as 'props' | 'item', path };
}

export function bindingToken(namespace: 'props' | 'item', path: string): string {
  return `{{${namespace}.${path}}}`;
}

/**
 * Which field types an inner block field can read, and through which
 * sub-value. A text field shows a link's address; a "new tab" checkbox reads
 * a link's new_tab.
 */
const SOURCES_FOR: Partial<Record<FieldType, Array<{ type: FieldType; suffix?: string }>>> = {
  text: [{ type: 'text' }, { type: 'textarea' }, { type: 'select' }, { type: 'number' }, { type: 'email' }, { type: 'url' }, { type: 'date' }, { type: 'link', suffix: 'href' }],
  textarea: [{ type: 'textarea' }, { type: 'text' }, { type: 'select' }],
  richtext: [{ type: 'richtext' }, { type: 'text' }, { type: 'textarea' }],
  url: [{ type: 'url' }, { type: 'link', suffix: 'href' }, { type: 'text' }],
  email: [{ type: 'email' }, { type: 'text' }],
  image: [{ type: 'image' }, { type: 'url' }],
  file: [{ type: 'file' }, { type: 'url' }],
  icon: [{ type: 'icon' }, { type: 'text' }],
  select: [{ type: 'select' }],
  boolean: [{ type: 'boolean' }, { type: 'link', suffix: 'new_tab' }],
  number: [{ type: 'number' }],
  color: [{ type: 'color' }],
  array: [{ type: 'array' }],
  link: [{ type: 'link' }],
  date: [{ type: 'date' }],
};

export function isBindableField(field: FieldDefinition): boolean {
  return field.type in SOURCES_FOR && field.type !== 'style';
}

export interface BindOption {
  /** The binding to store, e.g. `{{item.link.href}}`. */
  value: string;
  label: string;
}

/**
 * Props (and, inside a repeater item, item fields) an inner field can be
 * bound to. Item fields come first: inside a list item they are what the
 * author usually means.
 */
export function bindingOptions(inner: FieldDefinition, scope: { props: readonly FieldDefinition[]; item?: readonly FieldDefinition[]; itemLabel?: string }): BindOption[] {
  const sources = SOURCES_FOR[inner.type] ?? [];
  const options: BindOption[] = [];
  const collect = (fields: readonly FieldDefinition[], namespace: 'props' | 'item', prefix: string) => {
    for (const source of sources) {
      for (const field of fields) {
        if (field.type !== source.type) continue;
        if (inner.type === 'select' && field.type === 'select' && !(field.options ?? []).every(option => (inner.options ?? []).includes(option))) continue;
        const path = source.suffix ? `${field.name}.${source.suffix}` : field.name;
        const detail = source.suffix === 'href' ? ' (address)' : source.suffix === 'new_tab' ? ' (opens in a new tab)' : '';
        options.push({ value: bindingToken(namespace, path), label: `${prefix}${field.label}${detail}` });
      }
    }
  };
  if (scope.item) collect(scope.item, 'item', `${scope.itemLabel ?? 'Item'} › `);
  collect(scope.props, 'props', '');
  return options;
}

/** Human label of a binding against the schema, e.g. "Items › Heading". */
export function describeBinding(binding: ParsedBinding, scope: { props: readonly FieldDefinition[]; item?: readonly FieldDefinition[]; itemLabel?: string }): string {
  const fields = binding.namespace === 'item' ? scope.item ?? [] : scope.props;
  const field = fields.find(candidate => candidate.name === binding.path[0]);
  const head = field?.label ?? binding.path[0] ?? '';
  const rest = binding.path.slice(1).join('.');
  const prefix = binding.namespace === 'item' ? `${scope.itemLabel ?? 'Item'} › ` : '';
  return `${prefix}${head}${rest === 'href' ? ' (address)' : rest === 'new_tab' ? ' (new tab)' : rest ? ` › ${rest}` : ''}${field ? '' : ' (missing field)'}`;
}

/**
 * The item fields in scope for a block of a composition: those of the array
 * prop the nearest enclosing repeater loops over. A repeater's own fields
 * are outside its loop.
 */
export function itemScopeFor(composition: readonly Block[], blockId: string, schema: readonly FieldDefinition[]): { fields: FieldDefinition[]; label: string } | undefined {
  const visit = (blocks: readonly Block[], scope: { fields: FieldDefinition[]; label: string } | undefined): { fields: FieldDefinition[]; label: string } | undefined | null => {
    for (const block of blocks) {
      if (block.id === blockId) return scope;
      let childScope = scope;
      if (block.type === 'core/repeater' && !block.data?.item_block) {
        const binding = parseBinding(block.data?.items);
        const field = binding?.namespace === 'props' ? schema.find(candidate => candidate.name === binding.path[0] && candidate.type === 'array') : undefined;
        childScope = field ? { fields: field.fields ?? [], label: field.label } : undefined;
      }
      const inChildren = block.children ? visit(block.children, childScope) : null;
      if (inChildren !== null) return inChildren;
      for (const slot of block.slots ?? []) {
        const inSlot = visit(slot, scope);
        if (inSlot !== null) return inSlot;
      }
    }
    return null;
  };
  return visit(composition, undefined) ?? undefined;
}

// ─── Fields ──────────────────────────────────────────────────────────────

/** Properties the shared validator accepts on a block type field. */
const PROP_FIELD_KEYS = ['name', 'type', 'label', 'help', 'required', 'default', 'placeholder', 'options', 'option_labels', 'fields',
  'item_label', 'min_items', 'max_items', 'min', 'max', 'style_target', 'editor_group', 'ref_content_type', 'choices_markup'] as const;

/**
 * A prop field modelled on an inner block's field: same type and choices,
 * without block-specific settings the validator does not accept (responsive
 * values, CSS units, render-version gates).
 */
export function propFieldFrom(inner: FieldDefinition, name: string, label: string): FieldDefinition {
  const copy = (field: FieldDefinition): FieldDefinition => {
    const out: Record<string, unknown> = {};
    for (const key of PROP_FIELD_KEYS) {
      const value = (field as unknown as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = key === 'fields' ? (value as FieldDefinition[]).map(copy) : structuredClone(value);
    }
    return out as unknown as FieldDefinition;
  };
  const field = copy(inner);
  field.name = name;
  field.label = label;
  // Placement chooses the value; an inner block's "required" was about its own editor.
  delete field.required;
  delete field.default;
  if (field.editor_group === 'content') delete field.editor_group;
  return field;
}

/** A field name from a label: lowercase snake case, not taken yet. */
export function suggestFieldName(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base || !/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, '');
  base = base.slice(0, 48).replace(/_(svg|html|options_html)$/, '_text');
  if (['id', 'children', 'props', 'item', 'page', 'site', 'content_type', 'collection'].includes(base)) base = `${base}_text`;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  return name;
}

/** A block type name (`[a-z0-9][a-z0-9_-]*`) from a label. */
export function suggestTypeName(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56) || 'block';
  if (!/^[a-z0-9]/.test(base)) base = `block_${base}`;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  return name;
}

// ─── Turn a selection into a composed block type ─────────────────────────

/** Field types offered as props when turning blocks into a block type. */
const CONTENT_PROP_TYPES = new Set<FieldType>(['text', 'textarea', 'richtext', 'url', 'image', 'icon', 'email']);

export interface PropCandidate {
  blockId: string;
  /** What the author sees for the block: its name, its type label. */
  blockLabel: string;
  field: FieldDefinition;
  value: unknown;
  /** Proposed prop name, unique among all candidates. */
  name: string;
  /** Proposed prop label. */
  label: string;
}

/**
 * Inner-block fields of a subtree that can become props: content fields
 * (text, rich text, links, images, icons) with a plain value set. Responsive
 * values and values already bound stay in the composition as they are.
 */
export function propCandidates(root: Block, registry: ReadonlyMap<string, BlockType>): PropCandidate[] {
  const out: PropCandidate[] = [];
  const taken = new Set<string>();
  const visit = (block: Block) => {
    const type = registry.get(block.type);
    if (type && !type.composition?.length) {
      const fields = (type.schema ?? []).filter(field => {
        const value = block.data?.[field.name];
        return CONTENT_PROP_TYPES.has(field.type) && (field.editor_group ?? 'content') === 'content'
          && typeof value === 'string' && value.trim() !== '' && !/\{\{/.test(value);
      });
      for (const field of fields) {
        const value = block.data![field.name];
        // The block's first filled content field is labelled after the block; names follow labels.
        const primary = fields[0] === field;
        const label = primary ? (block.name?.trim() || type.label) : `${block.name?.trim() || type.label} ${field.label.toLowerCase()}`;
        const name = suggestFieldName(label, taken);
        taken.add(name);
        out.push({ blockId: block.id, blockLabel: block.name?.trim() || type.label, field, value, name, label });
      }
    }
    for (const child of block.children ?? []) visit(child);
    for (const slot of block.slots ?? []) for (const child of slot) visit(child);
  };
  visit(root);
  return out;
}

export interface PropPick {
  blockId: string;
  fieldName: string;
  name: string;
  label: string;
}

export interface SelectionComposition {
  composition: Block[];
  schema: FieldDefinition[];
  /** The values the instance replacing the selection starts with. */
  data: Record<string, unknown>;
}

/**
 * A composition from a block subtree: the chosen inner fields become props
 * (bound with `{{props.name}}`), every other value stays fixed. The instance
 * that replaces the selection carries the original values, so the page
 * renders the same text.
 */
export function compositionFromSelection(root: Block, picks: readonly PropPick[], registry: ReadonlyMap<string, BlockType>): SelectionComposition {
  const names = new Set<string>();
  for (const pick of picks) {
    if (names.has(pick.name)) throw new Error(`The field name "${pick.name}" is used twice.`);
    names.add(pick.name);
  }
  const schema: FieldDefinition[] = [];
  const data: Record<string, unknown> = {};
  const byBlock = new Map<string, PropPick[]>();
  for (const pick of picks) byBlock.set(pick.blockId, [...(byBlock.get(pick.blockId) ?? []), pick]);
  const visit = (block: Block): Block => {
    const next: Block = { ...block, data: { ...(block.data ?? {}) } };
    delete next.name;
    for (const pick of byBlock.get(block.id) ?? []) {
      const field = registry.get(block.type)?.schema.find(candidate => candidate.name === pick.fieldName);
      if (!field) throw new Error(`${block.type} has no field "${pick.fieldName}".`);
      data[pick.name] = structuredClone(block.data?.[pick.fieldName]);
      next.data[pick.fieldName] = bindingToken('props', pick.name);
      schema.push(propFieldFrom(field, pick.name, pick.label));
    }
    if (block.children) next.children = block.children.map(visit);
    if (block.slots) next.slots = block.slots.map(slot => slot.map(visit));
    return next;
  };
  return { composition: [visit(structuredClone(root))], schema, data };
}

// ─── Detach an instance ──────────────────────────────────────────────────

/** Only link-bearing fields, so derivation adds href/target/rel and nothing else (no inline SVG). */
function linkDerivationSchema(fields: readonly FieldDefinition[] | undefined): FieldDefinition[] {
  return (fields ?? []).flatMap(field => {
    if (field.type === 'link') return [field];
    if ((field.type === 'array' || field.type === 'object') && field.fields?.length) {
      const inner = linkDerivationSchema(field.fields);
      return inner.length ? [{ ...field, fields: inner }] : [];
    }
    return [];
  });
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The blocks a composed block instance is made of, with every `{{props.…}}`
 * binding replaced by the instance's value, so they can be edited freely on
 * the page. Repeaters keep `{{item.…}}` bindings and receive the items, with
 * links already resolved (pass `pageUrl` to keep links to pages).
 */
export function detachComposedInstance(block: Block, blockType: BlockType, pageUrl?: PageUrlResolver, makeId: () => string = newBlockId): Block[] {
  const props = deriveFieldValues(linkDerivationSchema(blockType.schema), withFieldDefaults(blockType.schema, block.data ?? {}), pageUrl);
  const resolve = (blocks: readonly Block[]): Block[] => blocks.map(inner => {
    const data: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(inner.data ?? {})) {
      const binding = parseBinding(raw);
      if (binding?.namespace === 'props') {
        const value = readPath(props, binding.path);
        if (value !== undefined && value !== null && value !== '') data[key] = structuredClone(value);
      } else {
        data[key] = structuredClone(raw);
      }
    }
    return {
      ...inner,
      data,
      ...(inner.children ? { children: resolve(inner.children) } : {}),
      ...(inner.slots ? { slots: inner.slots.map(slot => resolve(slot)) } : {}),
    };
  });
  return resolve(blockType.composition ?? []).map(inner => withFreshIds(inner, makeId));
}

// ─── Definitions ─────────────────────────────────────────────────────────

/** The definition as the API takes it: only writable properties, no empty script. */
export function writableDefinition(type: Partial<BlockType>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BLOCK_TYPE_WRITABLE) {
    const value = (type as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (key === 'script' && typeof value === 'string' && !value.trim()) continue;
    if (key === 'icon' && value === '') continue;
    out[key] = value;
  }
  if (Array.isArray(out.composition) && (out.composition as unknown[]).length) {
    delete out.template;
    if (out.container === false) delete out.container;
  } else {
    delete out.composition;
  }
  return out;
}

export type BlockTypeMode = 'composed' | 'template';

export function blockTypeMode(type: Partial<BlockType>): BlockTypeMode {
  return Array.isArray(type.composition) ? 'composed' : 'template';
}

/** A blank composed block type: a container with a heading bound to a Heading prop. */
export function blankComposedDefinition(): Partial<BlockType> {
  return {
    name: '', label: '', category: 'custom',
    schema: [{ name: 'title', type: 'text', label: 'Heading' }],
    composition: [{ id: 'root', type: 'core/container', data: { gap: 'sm' }, children: [
      { id: 'title', type: 'core/heading', data: { text: '{{props.title}}', level: 'h2' } },
    ] }],
    styles: '',
  };
}

/** A blank template block type: markup with one field. */
export function blankTemplateDefinition(): Partial<BlockType> {
  return {
    name: '', label: '', category: 'custom', container: false,
    schema: [{ name: 'title', type: 'text', label: 'Heading' }],
    template: '<div class="my-block">\n  <h2 class="my-block__title">{{title}}</h2>\n</div>',
    styles: '.my-block__title { margin: 0; }',
  };
}

// ─── Schema changes ──────────────────────────────────────────────────────

export interface SchemaChanges {
  /** Field paths (dotted inside groups) that no longer exist. */
  removed: string[];
  /** Field paths that are new. */
  added: string[];
  /** Field paths whose type changed. */
  retyped: string[];
}

export function schemaChanges(before: readonly FieldDefinition[], after: readonly FieldDefinition[]): SchemaChanges {
  const out: SchemaChanges = { removed: [], added: [], retyped: [] };
  const walk = (a: readonly FieldDefinition[], b: readonly FieldDefinition[], prefix: string) => {
    for (const field of a) {
      const match = b.find(candidate => candidate.name === field.name);
      const path = `${prefix}${field.name}`;
      if (!match) out.removed.push(path);
      else if (match.type !== field.type) out.retyped.push(path);
      else if (field.fields || match.fields) walk(field.fields ?? [], match.fields ?? [], `${path}.`);
    }
    for (const field of b) if (!a.some(candidate => candidate.name === field.name)) out.added.push(`${prefix}${field.name}`);
  };
  walk(before, after, '');
  return out;
}

/**
 * Fields whose name changed in place: same position and type at the same
 * level, as when an author edits a field's name. Old dotted path → new
 * dotted path.
 */
export function detectRenames(before: readonly FieldDefinition[], after: readonly FieldDefinition[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (a: readonly FieldDefinition[], b: readonly FieldDefinition[], oldPrefix: string, newPrefix: string) => {
    if (a.length !== b.length) return;
    a.forEach((field, index) => {
      const next = b[index]!;
      if (next.type !== field.type) return;
      const renamed = next.name !== field.name && !a.some(other => other.name === next.name) && !b.some(other => other.name === field.name);
      if (renamed) out[`${oldPrefix}${field.name}`] = `${newPrefix}${next.name}`;
      if (field.fields && next.fields) walk(field.fields, next.fields, `${oldPrefix}${field.name}.`, `${newPrefix}${next.name}.`);
    });
  };
  walk(before, after, '', '');
  return out;
}

/**
 * A composition with its bindings following renamed fields: `{{props.old}}`
 * becomes `{{props.new}}`, and inside a repeater over a list field whose
 * item fields were renamed, `{{item.old}}` becomes `{{item.new}}`.
 */
export function renameBindings(composition: readonly Block[], renames: Record<string, string>): Block[] {
  if (!Object.keys(renames).length) return composition as Block[];
  const rename = (path: string) => renames[path] ?? path;
  const rewrite = (value: unknown, namespace: 'props' | 'item', prefix: string): unknown => {
    const binding = parseBinding(value);
    if (!binding || binding.namespace !== namespace) return value;
    const [head, ...rest] = binding.path;
    const renamed = rename(`${prefix}${head}`);
    const name = renamed.slice(renamed.lastIndexOf('.') + 1);
    return name === head ? value : bindingToken(namespace, [name, ...rest].join('.'));
  };
  const visit = (blocks: readonly Block[], itemPrefix: string | null): Block[] => blocks.map(block => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block.data ?? {})) {
      let next = rewrite(value, 'props', '');
      if (itemPrefix !== null) next = rewrite(next, 'item', itemPrefix);
      data[key] = next;
    }
    let childPrefix = itemPrefix;
    if (block.type === 'core/repeater' && !block.data?.item_block) {
      const binding = parseBinding(block.data?.items);
      // The composition still uses the old names, the keys of `renames`.
      childPrefix = binding?.namespace === 'props' ? `${binding.path[0]}.` : null;
    }
    return {
      ...block,
      data,
      ...(block.children ? { children: visit(block.children, childPrefix) } : {}),
      ...(block.slots ? { slots: block.slots.map(slot => visit(slot, itemPrefix)) } : {}),
    };
  });
  return visit(composition, null);
}

/** Fields at the same level as `path` (dotted), for rename choices. */
export function siblingPaths(paths: readonly string[], path: string): string[] {
  const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.') + 1) : '';
  return paths.filter(candidate => candidate.startsWith(parent) && !candidate.slice(parent.length).includes('.'));
}

// ─── CSS class hints ─────────────────────────────────────────────────────

export interface CssHint {
  className: string;
  label: string;
  /** The selector to insert; defaults to `.className`. */
  selector?: string;
}

/** Selectors worth styling in a composition: custom classes and the inner block kinds. */
export function compositionCssHints(composition: readonly Block[], registry: ReadonlyMap<string, BlockType>): CssHint[] {
  const hints = new Map<string, CssHint>();
  const visit = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      const classes = [block.data?.css_class, block.style_overrides?.custom_class].filter((value): value is string => typeof value === 'string');
      for (const token of classes.join(' ').split(/\s+/)) if (token) hints.set(`.${token}`, { className: token, label: `Class on ${registry.get(block.type)?.label ?? block.type}` });
      const name = registry.get(block.type)?.name ?? block.type.split('/').pop()!;
      const selector = `[data-block="${name}"]`;
      if (!hints.has(selector)) hints.set(selector, { className: name, label: `Every ${registry.get(block.type)?.label ?? name} block inside`, selector });
      if (block.children) visit(block.children);
      for (const slot of block.slots ?? []) visit(slot);
    }
  };
  visit(composition);
  return [...hints.values()].slice(0, 40);
}

/** Classes used in template markup. */
export function templateCssHints(template: string): CssHint[] {
  const classes = new Set<string>();
  for (const match of template.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of match[1]!.replace(/\{\{[^}]*\}\}/g, ' ').split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(token)) classes.add(token);
  }
  return [...classes].slice(0, 40).map(className => ({ className, label: 'Class in the markup' }));
}

// ─── Template autocomplete ───────────────────────────────────────────────

export interface Completion {
  /** Shown in the list. */
  label: string;
  /** Replaces the typed token, starting after `{{`. */
  insert: string;
  detail: string;
}

function valueNames(fields: readonly FieldDefinition[]): Completion[] {
  const out: Completion[] = [];
  for (const field of fields) {
    out.push({ label: field.name, insert: `${field.name}}}`, detail: field.label });
    if (field.type === 'icon') out.push({ label: `{${field.name}_svg}`, insert: `{${field.name}_svg}}}`, detail: `${field.label} as SVG (raw)` });
    if (field.type === 'richtext') out.push({ label: `{${field.name}}`, insert: `{${field.name}}}}`, detail: `${field.label} as HTML (raw)` });
    if (field.type === 'link') for (const key of ['href', 'target', 'rel']) out.push({ label: `${field.name}.${key}`, insert: `${field.name}.${key}}}`, detail: `${field.label} ${key}` });
  }
  return out;
}

/**
 * Suggestions for the token being typed at the end of `before` (the markup
 * up to the cursor), or null when the cursor is not inside `{{`. Inside an
 * `{{#each list}}` the list's item fields and loop values are offered too.
 */
export function templateCompletions(schema: readonly FieldDefinition[], before: string): { from: number; items: Completion[] } | null {
  const match = /\{\{(\{?[#^/]?)((?:each |link )?[\w.@]*)$/.exec(before);
  if (!match) return null;
  const typed = `${match[1]}${match[2]}`;
  const from = before.length - typed.length;
  // Open sections before the cursor, innermost last.
  const open: Array<{ kind: string; name: string }> = [];
  for (const section of before.slice(0, match.index).matchAll(/\{\{\s*([#^/])\s*(each\s+|link\s+)?([\w.@]+)[^}]*\}\}/g)) {
    const [, sigil, keyword, name] = section;
    if (sigil === '/') open.pop();
    else open.push({ kind: keyword?.trim() ?? (sigil === '^' ? '^' : '#'), name: name! });
  }
  const loops = open.filter(section => section.kind === 'each').map(section => schema.find(field => field.name === section.name)?.fields ?? []);
  const scopes = [...loops.reverse(), schema];
  const items: Completion[] = [];
  for (const fields of scopes) items.push(...valueNames(fields));
  const flat = scopes.flat();
  for (const field of flat) {
    if (field.type === 'array') items.push({ label: `#each ${field.name}`, insert: `#each ${field.name}}}\n  \n{{/each}}`, detail: `Repeat for each ${field.label.toLowerCase()} item` });
    if (field.type === 'link' || field.type === 'url') items.push({ label: `#link ${field.name}`, insert: `#link ${field.name}}}{{/link}}`, detail: `Wrap in a link to ${field.label.toLowerCase()}` });
    items.push({ label: `#${field.name}`, insert: `#${field.name}}}{{/${field.name}}}`, detail: `Shown when ${field.label.toLowerCase()} is set` });
    items.push({ label: `^${field.name}`, insert: `^${field.name}}}{{/${field.name}}}`, detail: `Shown when ${field.label.toLowerCase()} is empty` });
  }
  if (loops.length) for (const name of ['@index', '@number', '@first', '@last']) items.push({ label: name, insert: `${name}}}`, detail: 'Loop value' });
  const last = open[open.length - 1];
  if (last) items.unshift({ label: `/${last.kind === 'each' || last.kind === 'link' ? last.kind : last.name}`, insert: `/${last.kind === 'each' || last.kind === 'link' ? last.kind : last.name}}}`, detail: 'Close the open section' });
  for (const name of ['page.title', 'site.name', 'children']) items.push({ label: name, insert: `${name}}}`, detail: name === 'children' ? 'Child blocks (container types)' : 'From the page or Site' });
  const seen = new Set<string>();
  const filtered = items.filter(item => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return item.label.startsWith(typed) || item.label.replace(/^\{/, '').startsWith(typed);
  });
  return { from, items: filtered.slice(0, 30) };
}
