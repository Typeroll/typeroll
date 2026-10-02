/**
 * The one validator for site block type definitions. The portal, the v1 API,
 * MCP and the chat all write block types through it, so every surface
 * accepts the same properties and reports the same problems.
 *
 * A block type is either composed (`composition`, a tree of existing blocks
 * reading the block's props through bindings) or a template (`template`, its
 * own markup). Both declare their editable fields in `schema` and may carry a
 * stylesheet, which is scoped to the block (block-css-scope.ts).
 *
 * Each problem carries a JSON-pointer `path` and, for template and CSS
 * problems, a 1-based line. Errors refuse the write; warnings do not.
 */

import { blockTreeError } from './block-tree-validation.js';
import { scopeBlockCss } from './block-css-scope.js';
import { COMPOSITION_MAX_DEPTH, walkComposition } from './composed-blocks.js';
import { CUSTOM_CSS_MAX_LENGTH, checkCustomCss } from './custom-css.js';
import { resolveRenderVersion } from './render-version.js';
import { parseSections, sectionNames, type SectionNode } from './template-sections.js';
import type { Block, BlockType, FieldDefinition, FieldType } from './types.js';

export interface BlockTypeProblem {
  severity: 'error' | 'warning';
  /** JSON pointer into the submitted definition, e.g. `/schema/0/fields/2/name`. */
  path: string;
  message: string;
  /** 1-based line within a template or stylesheet. */
  line?: number;
}

export const BLOCK_TYPE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_FIELD_NAMES = new Set(['id', 'children', 'props', 'item', 'page', 'site', 'content_type', 'collection']);
const DERIVED_SUFFIXES = ['_svg', '_options_html', '_html'];
const CATEGORIES = ['layout', 'content', 'media', 'custom'] as const;
const CONTAINERS = [false, true, 'slots', 'repeater', 'conditional'] as const;
export const BLOCK_TYPE_FIELD_TYPES: readonly FieldType[] = [
  'text', 'textarea', 'richtext', 'image', 'file', 'color', 'select', 'multiselect', 'boolean', 'number', 'url', 'email',
  'date', 'datetime', 'list', 'list_simple', 'icon', 'array', 'object', 'block_type_ref', 'content_type_ref', 'page_ref',
  'page_ref_list', 'style', 'global_block', 'link', 'choices',
];
const FIELD_KEYS = new Set(['name', 'type', 'label', 'help', 'required', 'default', 'placeholder', 'options', 'option_labels', 'fields',
  'item_label', 'min_items', 'max_items', 'responsive', 'min', 'max', 'style_target', 'editor_group', 'ref_content_type', 'choices_markup',
  'responsive_css', 'css_unit', 'item_key', 'style_default_role', 'min_render_version']);
/** Properties a block type definition may carry. */
export const BLOCK_TYPE_WRITABLE = ['name', 'label', 'icon', 'category', 'container', 'slot_count', 'slot_labels', 'item_compatible',
  'expand_to', 'schema', 'template', 'styles', 'script', 'composition', 'description'] as const;
export const MAX_FIELD_DEPTH = 3;
export const MAX_TEMPLATE_LENGTH = 100_000;
export const MAX_COMPOSITION_BYTES = 500_000;
const MAX_FIELDS = 100;
/** Sub-values a link exposes to templates and bindings. */
const LINK_KEYS = new Set(['href', 'target', 'rel', 'new_tab', 'page_id', 'url']);

export type BlockTypeWritable = Partial<Pick<BlockType, typeof BLOCK_TYPE_WRITABLE[number] & keyof BlockType>> & { description?: string };

export interface ValidateBlockTypeOptions {
  /** Validate a patch: only the submitted properties are checked and required ones may be absent. */
  partial?: boolean;
  /** The stored type a patch applies to; the merged result is checked as a whole. */
  existing?: BlockType;
  /** Looks up other block types (core and site) for compositions, aliases and repeaters. */
  resolveType: (id: string) => BlockType | undefined;
  /** Whether the caller may write `script` (see block-script-gate). */
  allowScript?: boolean;
  /** The site's render version; output that differs between versions is checked against it. */
  renderVersion?: number;
}

export interface ValidatedBlockType {
  /** The normalized properties to store (for a patch, only the changed ones plus `css_scope`). */
  value: BlockTypeWritable & { css_scope?: 'block' };
  /** The merged definition after the write, for previews and usage checks. */
  merged: BlockType;
  problems: BlockTypeProblem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Validate and normalize a block type definition or patch. */
export function validateBlockTypeDefinition(input: unknown, options: ValidateBlockTypeOptions): ValidatedBlockType {
  const problems: BlockTypeProblem[] = [];
  const error = (path: string, message: string, line?: number) => problems.push({ severity: 'error', path, message, ...(line ? { line } : {}) });
  const warn = (path: string, message: string, line?: number) => problems.push({ severity: 'warning', path, message, ...(line ? { line } : {}) });
  const value: ValidatedBlockType['value'] = {};
  const empty = { id: '', name: '', label: '', category: 'custom', container: false, schema: [], created_at: '' } as unknown as BlockType;
  if (!isRecord(input)) {
    error('', 'The block type must be a JSON object.');
    return { value, merged: options.existing ?? empty, problems };
  }
  const unknown = Object.keys(input).filter(key => !(BLOCK_TYPE_WRITABLE as readonly string[]).includes(key) && key !== 'id' && key !== 'origin');
  for (const key of unknown) error(`/${key}`, `Unknown property "${key}". Accepted: ${BLOCK_TYPE_WRITABLE.join(', ')}.`);
  const has = (key: string) => input[key] !== undefined;
  const partial = options.partial === true;

  if (has('name') || !partial) {
    if (typeof input.name !== 'string' || !BLOCK_TYPE_NAME_PATTERN.test(input.name)) error('/name', 'name must be 1–64 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit.');
    else if (partial && options.existing && input.name !== options.existing.name) error('/name', 'A block type cannot be renamed. Create a new one instead.');
    else value.name = input.name;
  }
  if (has('label') || !partial) {
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120) error('/label', 'label must be text up to 120 characters.');
    else value.label = input.label.trim();
  }
  if (has('description')) {
    if (typeof input.description !== 'string' || input.description.length > 500) error('/description', 'description must be text up to 500 characters.');
    else value.description = input.description.trim();
  }
  if (has('icon')) {
    if (typeof input.icon !== 'string' || input.icon.length > 64) error('/icon', 'icon must be an icon name.');
    else value.icon = input.icon;
  }
  if (has('category') || !partial) {
    const category = input.category ?? 'custom';
    if (!(CATEGORIES as readonly unknown[]).includes(category)) error('/category', `category must be one of ${CATEGORIES.join(', ')}.`);
    else value.category = category as BlockType['category'];
  }
  if (has('container')) {
    if (!(CONTAINERS as readonly unknown[]).includes(input.container)) error('/container', 'container must be false, true, "slots", "repeater" or "conditional".');
    else value.container = input.container as BlockType['container'];
  }
  if (has('slot_count')) {
    if (!Number.isInteger(input.slot_count) || (input.slot_count as number) < 1 || (input.slot_count as number) > 8) error('/slot_count', 'slot_count must be 1–8.');
    else value.slot_count = input.slot_count as number;
  }
  if (has('slot_labels')) {
    if (!Array.isArray(input.slot_labels) || input.slot_labels.some(label => typeof label !== 'string' || label.length > 60)) error('/slot_labels', 'slot_labels must be a list of short labels.');
    else value.slot_labels = input.slot_labels as string[];
  }
  if (has('item_compatible')) {
    if (typeof input.item_compatible !== 'boolean') error('/item_compatible', 'item_compatible must be true or false.');
    else value.item_compatible = input.item_compatible;
  }
  if (has('expand_to')) {
    const target = isRecord(input.expand_to) ? input.expand_to.target : undefined;
    if (!isRecord(input.expand_to) || typeof target !== 'string' || (input.expand_to.defaults !== undefined && !isRecord(input.expand_to.defaults))) error('/expand_to', 'expand_to must be { target, defaults }.');
    else if (!options.resolveType(target)) error('/expand_to/target', `Block type "${target}" does not exist.`);
    else value.expand_to = { target, defaults: (input.expand_to.defaults as Record<string, unknown>) ?? {} };
  }
  if (has('schema') || !partial) {
    if (!Array.isArray(input.schema)) error('/schema', 'schema must be a list of fields.');
    else {
      checkFields(input.schema, '/schema', 1, error, warn);
      value.schema = input.schema as FieldDefinition[];
    }
  }
  if (has('script')) {
    if (typeof input.script !== 'string' || input.script.length > MAX_TEMPLATE_LENGTH) error('/script', 'script must be text up to 100 000 characters.');
    else if (input.script.trim() && !options.allowScript) error('/script', 'Block scripts need explicit permission (see AI block scripts in Settings).');
    else value.script = input.script;
  }
  if (has('template')) {
    if (typeof input.template !== 'string' || input.template.length > MAX_TEMPLATE_LENGTH) error('/template', 'template must be text up to 100 000 characters.');
    else value.template = input.template;
  }
  if (has('composition')) {
    const treeProblem = blockTreeError(input.composition, 'composition', true);
    if (treeProblem) error('/composition', treeProblem);
    else if (JSON.stringify(input.composition).length > MAX_COMPOSITION_BYTES) error('/composition', 'A composition is limited to 500 KB.');
    else value.composition = input.composition as Block[];
  }
  if (has('styles')) {
    if (typeof input.styles !== 'string' || input.styles.length > CUSTOM_CSS_MAX_LENGTH) error('/styles', 'styles must be CSS up to 100 000 characters.');
    else {
      value.styles = input.styles;
      // Stylesheets written from now on are scoped to the block.
      value.css_scope = 'block';
    }
  }
  if (!partial) value.css_scope = 'block';

  const merged = { ...(options.existing ?? empty), ...value } as BlockType;
  if (!partial || options.existing) {
    const id = merged.id || merged.name;
    // Older stored types may have neither; only a create or a write of the
    // template or composition itself has to leave the type renderable.
    const needsOutput = !partial || has('template') || has('composition');
    if (needsOutput && !merged.template && !merged.composition?.length && !merged.expand_to && merged.container !== 'repeater' && merged.container !== 'conditional') {
      error('', 'A block type needs a composition (blocks it is built from) or a template (its own markup).');
    }
    if (merged.template && merged.composition?.length) error('/composition', 'A block type has either a composition or a template, not both.');
    if (merged.composition?.length && merged.container) error('/container', 'A composed block type cannot hold children; use a container block inside its composition.');
    if (merged.container === 'slots' && !Number.isInteger(merged.slot_count)) error('/slot_count', 'A slots container needs slot_count (1–8).');
    if (value.composition || (value.schema && merged.composition?.length)) checkComposition(merged, id, options.resolveType, error, warn);
    if (value.composition && options.renderVersion !== undefined) checkIconsInLinks(merged, options.resolveType, options.renderVersion, warn);
    if (value.template !== undefined || (value.schema && merged.template)) checkTemplate(merged, error, warn);
    if (value.styles !== undefined) checkStyles(merged.styles ?? '', merged.name, error, warn);
  }
  return { value, merged, problems };
}

function checkFields(
  fields: unknown[],
  path: string,
  depth: number,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  if (fields.length > MAX_FIELDS) error(path, `A block type can have at most ${MAX_FIELDS} fields per level.`);
  const names = new Set<string>();
  fields.forEach((raw, index) => {
    const at = `${path}/${index}`;
    if (!isRecord(raw)) { error(at, 'Each field must be an object with name, type and label.'); return; }
    for (const key of Object.keys(raw)) if (!FIELD_KEYS.has(key)) error(`${at}/${key}`, `Unknown field property "${key}".`);
    const name = raw.name;
    if (typeof name !== 'string' || !FIELD_NAME_PATTERN.test(name)) error(`${at}/name`, 'Field names are lowercase letters, digits and "_", starting with a letter.');
    else if (RESERVED_FIELD_NAMES.has(name)) error(`${at}/name`, `"${name}" is reserved.`);
    else if (DERIVED_SUFFIXES.some(suffix => name.endsWith(suffix))) error(`${at}/name`, `Field names cannot end in ${DERIVED_SUFFIXES.join(', ')}; those names are derived.`);
    else if (names.has(name)) error(`${at}/name`, `Field "${name}" appears twice.`);
    else names.add(name);
    if (!(BLOCK_TYPE_FIELD_TYPES as readonly unknown[]).includes(raw.type)) error(`${at}/type`, `type must be one of ${BLOCK_TYPE_FIELD_TYPES.join(', ')}.`);
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 120) error(`${at}/label`, 'label must be text up to 120 characters.');
    if (raw.help !== undefined && (typeof raw.help !== 'string' || raw.help.length > 500)) error(`${at}/help`, 'help must be text up to 500 characters.');
    if (raw.type === 'select' || raw.type === 'multiselect') {
      if (!Array.isArray(raw.options) || !raw.options.length || raw.options.some(option => typeof option !== 'string' || !option)) error(`${at}/options`, 'A select field needs a non-empty list of options.');
      else if (raw.option_labels !== undefined && (!Array.isArray(raw.option_labels) || raw.option_labels.length !== raw.options.length)) error(`${at}/option_labels`, 'option_labels must match options one to one.');
      else if (raw.default !== undefined && raw.type === 'select' && !raw.options.includes(raw.default as string)) error(`${at}/default`, 'The default must be one of the options.');
    }
    if (raw.type === 'array' || raw.type === 'object') {
      if (raw.fields !== undefined) {
        if (!Array.isArray(raw.fields)) error(`${at}/fields`, 'fields must be a list of fields.');
        else if (depth >= MAX_FIELD_DEPTH) error(`${at}/fields`, `Field groups nest at most ${MAX_FIELD_DEPTH} levels.`);
        else checkFields(raw.fields, `${at}/fields`, depth + 1, error, warn);
      } else if (raw.type === 'object') error(`${at}/fields`, 'An object field needs fields.');
    } else if (raw.fields !== undefined) error(`${at}/fields`, 'Only array and object fields have sub-fields.');
    if (raw.item_label !== undefined && (raw.type !== 'array' || !Array.isArray(raw.fields) || !raw.fields.some(field => isRecord(field) && field.name === raw.item_label))) {
      error(`${at}/item_label`, 'item_label must name a sub-field of this array.');
    }
    for (const key of ['min_items', 'max_items'] as const) {
      if (raw[key] === undefined) continue;
      if (raw.type !== 'array' || !Number.isInteger(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > 500) error(`${at}/${key}`, `${key} must be a whole number 0–500 on an array field.`);
    }
    if (Number.isInteger(raw.min_items) && Number.isInteger(raw.max_items) && (raw.min_items as number) > (raw.max_items as number)) error(`${at}/min_items`, 'min_items cannot exceed max_items.');
    if (raw.required !== undefined && typeof raw.required !== 'boolean') error(`${at}/required`, 'required must be true or false.');
  });
}

/** Fields at a path of array names, for `{{item.x}}` checks inside repeaters. */
function subFields(schema: readonly FieldDefinition[], arrayName: string): FieldDefinition[] | undefined {
  const field = schema.find(candidate => candidate.name === arrayName);
  return field?.type === 'array' ? field.fields ?? [] : undefined;
}

/** True when `rest` (after a field name) is a valid path into that field's value. */
function validPath(field: FieldDefinition | undefined, rest: string[]): boolean {
  if (!field) return false;
  if (!rest.length) return true;
  if (field.type === 'link') return rest.length === 1 && LINK_KEYS.has(rest[0]!);
  if (field.type === 'object') return validPath(field.fields?.find(child => child.name === rest[0]), rest.slice(1));
  if (field.type === 'image') return rest.length === 1;
  return false;
}

function knownName(fields: readonly FieldDefinition[], name: string): boolean {
  const [head, ...rest] = name.split('.');
  const direct = fields.find(field => field.name === head);
  if (direct) return validPath(direct, rest);
  // Derived values: `<icon>_svg`, `<choices>_options_html`, `<part>_class`.
  if (!rest.length) {
    if (head!.endsWith('_svg')) return fields.some(field => field.type === 'icon' && `${field.name}_svg` === head);
    if (head!.endsWith('_options_html')) return fields.some(field => field.type === 'choices' && `${field.name}_options_html` === head);
    if (head!.endsWith('_class')) return fields.some(field => field.type === 'style' && field.name === head!.replace(/_class$/, '_style_id'));
  }
  return false;
}

const BINDING = /^\s*\{\{\s*((?:page|site|item|props|content_type)\.[\w.-]+)\s*\}\}\s*$/;
const INLINE_TOKEN = /\{\{\s*(?:props|item)\.[\w.-]+\s*\}\}/;

function checkComposition(
  type: BlockType,
  selfId: string,
  resolveType: (id: string) => BlockType | undefined,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  const schema = type.schema ?? [];
  const visit = (blocks: readonly Block[], path: string, itemFields: FieldDefinition[] | undefined) => {
    blocks.forEach((block, index) => {
      const at = `${path}/${index}`;
      const inner = resolveType(block.type);
      if (!inner) { error(`${at}/type`, `Block type "${block.type}" does not exist.`); return; }
      if (block.type === selfId || block.type === type.name) { error(`${at}/type`, 'A block type cannot contain itself.'); return; }
      if (composedDepth(inner, resolveType, new Set([selfId])) >= COMPOSITION_MAX_DEPTH) error(`${at}/type`, `Composed blocks nest at most ${COMPOSITION_MAX_DEPTH} levels, and never in a loop.`);
      let childItems = itemFields;
      for (const [key, raw] of Object.entries(block.data ?? {})) {
        if (typeof raw !== 'string') continue;
        const binding = BINDING.exec(raw);
        if (binding) {
          const [namespace, ...rest] = binding[1]!.split('.');
          if (namespace === 'props' && !knownName(schema, rest.join('.'))) error(`${at}/data/${key}`, `{{${binding[1]}}} names no field of this block type.`);
          if (namespace === 'item') {
            if (!itemFields) warn(`${at}/data/${key}`, `{{${binding[1]}}} is outside a repeater over a list field, so it reads the page's item, if any.`);
            else if (!knownName(itemFields, rest.join('.'))) error(`${at}/data/${key}`, `{{${binding[1]}}} names no field of the list items.`);
          }
          if (block.type === 'core/repeater' && key === 'items' && namespace === 'props') {
            childItems = subFields(schema, rest[0]!);
            if (!childItems) error(`${at}/data/items`, `{{${binding[1]}}} must name a list field.`);
          }
        } else if (INLINE_TOKEN.test(raw)) {
          warn(`${at}/data/${key}`, 'Bindings only resolve as a whole value, e.g. "{{props.title}}"; text around them is shown as typed.');
        }
      }
      if (block.children) visit(block.children, `${at}/children`, block.type === 'core/repeater' ? childItems : itemFields);
      block.slots?.forEach((slot, slotIndex) => visit(slot, `${at}/slots/${slotIndex}`, itemFields));
    });
  };
  visit(type.composition ?? [], '/composition', undefined);
  if (schema.some(field => field.responsive)) error('/schema', 'Fields of a composed block type cannot be responsive; set responsive values on the blocks inside it.');
}

/**
 * Before render version 4 an icon always sits in a link of its own, even
 * without an address. Inside a linked container that nests links, and the
 * browser splits the container's link apart.
 */
function checkIconsInLinks(
  type: BlockType,
  resolveType: (id: string) => BlockType | undefined,
  renderVersion: number,
  warn: (path: string, message: string) => void,
): void {
  if (resolveRenderVersion(renderVersion) >= 4) return;
  const containsIcon = (blocks: readonly Block[] | undefined, seen: Set<string>): boolean => {
    let found = false;
    walkComposition(blocks, block => {
      if (found) return;
      if (block.type === 'core/icon') { found = true; return; }
      const inner = resolveType(block.type);
      if (inner?.composition?.length && !seen.has(inner.id)) found = containsIcon(inner.composition, new Set([...seen, inner.id]));
    });
    return found;
  };
  const visit = (blocks: readonly Block[], path: string) => {
    blocks.forEach((block, index) => {
      const at = `${path}/${index}`;
      if (block.type === 'core/container' && block.data?.tag === 'a' && containsIcon(block.children, new Set([type.id]))) {
        warn(`${at}/data/tag`, `This site renders with render version ${resolveRenderVersion(renderVersion)}, where an icon always sits in a link of its own, so an icon inside this linked container nests links and breaks the container's link. Upgrade the site to render version 4 or later, or move the icon out of the linked container.`);
        return;
      }
      if (block.children) visit(block.children, `${at}/children`);
      block.slots?.forEach((slot, slotIndex) => visit(slot, `${at}/slots/${slotIndex}`));
    });
  };
  visit(type.composition ?? [], '/composition');
}

function composedDepth(type: BlockType, resolveType: (id: string) => BlockType | undefined, path: Set<string>): number {
  if (!type.composition?.length) return 0;
  if (path.has(type.id) || path.size > COMPOSITION_MAX_DEPTH) return COMPOSITION_MAX_DEPTH;
  let deepest = 0;
  walkComposition(type.composition, block => {
    const inner = resolveType(block.type);
    if (inner?.composition?.length) deepest = Math.max(deepest, composedDepth(inner, resolveType, new Set([...path, type.id])));
  });
  return deepest + 1;
}

const TOKEN = /\{\{(\{?)\s*(=?)\s*([@\w.:-]+)\s*\}?\}\}/g;

function checkTemplate(
  type: BlockType,
  error: (path: string, message: string, line?: number) => void,
  warn: (path: string, message: string, line?: number) => void,
): void {
  const template = type.template ?? '';
  const parsed = parseSections(template);
  if (parsed.error) { error('/template', parsed.error.message, lineAt(template, parsed.error.index)); return; }
  const schema = type.schema ?? [];
  // Check names in each text node against the fields in scope at that point.
  let offset = 0;
  const visit = (nodes: readonly SectionNode[], scopes: FieldDefinition[][], inLoop: boolean) => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        for (const match of node.text.matchAll(TOKEN)) {
          const [, raw, , name] = match;
          const index = template.indexOf(node.text, offset) + (match.index ?? 0);
          const line = lineAt(template, Math.max(0, index));
          if (name === 'children' || name!.startsWith('slot:')) continue;
          if (name!.startsWith('@')) { if (!inLoop) error('/template', `{{${name}}} is only available inside {{#each}}.`, line); continue; }
          if (/^(?:page|site|item|content_type)\./.test(name!)) continue;
          if (!scopes.some(fields => knownName(fields, name!))) { error('/template', `{{${name}}} names no field.`, line); continue; }
          if (raw === '{') {
            const field = scopes.flat().find(candidate => candidate.name === name);
            if (field && field.type !== 'richtext') error('/template', `{{{${name}}}} inserts raw HTML; only richtext fields and derived HTML (…_svg, …_html) may. Use {{${name}}}.`, line);
          }
        }
        offset = Math.max(offset, template.indexOf(node.text, offset));
        continue;
      }
      const fields = scopes.flat();
      if (node.kind === 'each') {
        const field = fields.find(candidate => candidate.name === node.name);
        if (field?.type !== 'array') { error('/template', `{{#each ${node.name}}} needs a list field.`); visit(node.body, scopes, true); continue; }
        visit(node.body, [field.fields ?? [], ...scopes], true);
        continue;
      }
      if (node.kind === 'link') {
        const field = fields.find(candidate => candidate.name === node.name);
        if (!field || !['link', 'url'].includes(field.type)) error('/template', `{{#link ${node.name}}} needs a link or url field.`);
      } else if (!node.name.startsWith('@') && !/^(?:page|site|item|content_type)\./.test(node.name) && !scopes.some(scope => knownName(scope, node.name))) {
        error('/template', `{{${node.inverted ? '^' : '#'}${node.name}}} names no field.`);
      }
      visit(node.body, scopes, inLoop);
    }
  };
  visit(parsed.nodes, [schema], false);
  if (sectionNames(parsed.nodes).filter(entry => entry.kind === 'each').some(entry => entry.depth >= MAX_FIELD_DEPTH)) warn('/template', 'Deeply nested loops are hard to edit; consider a composed block type.');
}

function checkStyles(
  styles: string,
  name: string,
  error: (path: string, message: string, line?: number) => void,
  warn: (path: string, message: string, line?: number) => void,
): void {
  for (const problem of checkCustomCss(styles)) {
    // Block stylesheets are scoped, so selecting the block's own markup is expected.
    if (problem.code === 'platform_selector') continue;
    (problem.severity === 'error' ? error : warn)('/styles', problem.message, problem.line);
  }
  const { rejected } = scopeBlockCss(styles, name);
  for (const selector of rejected) error('/styles', `"${selector}" styles the whole page; a block stylesheet styles only its own block. Use :scope for the block itself.`);
}

/** Sample props for a preview: defaults, or a short placeholder per field type. */
export function sampleBlockData(fields: readonly FieldDefinition[] | undefined, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields ?? []) {
    if (field.default !== undefined) { out[field.name] = field.default; continue; }
    switch (field.type) {
      case 'text': case 'textarea': out[field.name] = field.label; break;
      case 'richtext': out[field.name] = `<p>${field.label}</p>`; break;
      case 'icon': out[field.name] = 'star'; break;
      case 'select': out[field.name] = field.options?.[0] ?? ''; break;
      case 'boolean': out[field.name] = false; break;
      case 'number': out[field.name] = field.min ?? 1; break;
      case 'link': out[field.name] = { url: '#' }; break;
      case 'url': out[field.name] = '#'; break;
      case 'array':
        out[field.name] = depth < MAX_FIELD_DEPTH && field.fields?.length
          ? Array.from({ length: Math.max(field.min_items ?? 0, 3) }, (_, index) => {
            const item = sampleBlockData(field.fields, depth + 1);
            for (const sub of field.fields ?? []) if ((sub.type === 'text' || sub.type === 'textarea') && sub.default === undefined) item[sub.name] = `${sub.label} ${index + 1}`;
            return item;
          })
          : [];
        break;
      case 'object': out[field.name] = sampleBlockData(field.fields, depth + 1); break;
      default: break;
    }
  }
  return out;
}

/** Block types a composition, alias or repeater item of `type` uses directly. */
export function referencedBlockTypes(type: Pick<BlockType, 'composition' | 'expand_to'>): string[] {
  const ids = new Set<string>();
  walkComposition(type.composition, block => {
    ids.add(block.type);
    const item = block.data?.item_block;
    if (typeof item === 'string' && item) ids.add(item);
  });
  if (type.expand_to?.target) ids.add(type.expand_to.target);
  const item = type.expand_to?.defaults?.item_block;
  if (typeof item === 'string' && item) ids.add(item);
  return [...ids];
}
