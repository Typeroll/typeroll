/**
 * Block parts: named sub-elements of a block type that site styles can style.
 *
 * A block's CSS carries fixed opinions (a link underline, an eyebrow's
 * letter spacing, a button's radius). Before parts, the only way to change
 * one that no field reached was site CSS against platform markup. A part
 * names such an element once, on the block type:
 *
 *   parts: [{ name: 'link', label: 'Links', selector: 'a', target: 'link' }]
 *
 * and the style library reaches it two ways:
 *
 * - site-wide: a style lists the part in `parts` (`core/rich_heading.link`)
 *   and applies to that part of every instance;
 * - per instance: the block's `part_styles` data (`{ link: 'quiet-link' }`),
 *   a field every type with parts gets automatically (`withPartStylesField`).
 *
 * Precedence, lowest first: the block's own CSS (fields included), the
 * default role style (`tr-role-*`), the part style (the instance's choice
 * replaces the site-wide one), and a style class on the element itself
 * (`s-<id>`, e.g. a heading's `eyebrow_style_id` or a class from the rich
 * text editor). Part rules are wrapped as
 *
 *   :where(<scope> <selector>):not([class^="s-"],[class*=" s-"]):not(#\#):not(#\#)
 *
 * so the specificity is always (2,1,0): above every block rule and the
 * `.s-<id>:not(#\#)` class styles, without !important, while an element
 * carrying a chosen style class is left to that class. The site-wide scope is
 * `[data-block="<name>"]:not([data-part-<part>])`; an instance with its own
 * choice renders `data-part-<part>="<style id>"` on its root and is scoped by
 * that attribute instead, so exactly one part style applies.
 *
 * Nothing here changes output for a block or site that sets no part style:
 * the attribute and the CSS are absent.
 */

import type { BreakpointWidths } from './breakpoints.js';
import type { TextUse } from './contrast.js';
import { closestFieldNames } from './closest-names.js';
import { LATEST_RENDER_VERSION, resolveRenderVersion } from './render-version.js';
import {
  COLOR_TOKENS,
  STYLE_ELEMENT_ROLES,
  STYLE_ID_PATTERN,
  STYLE_TARGETS,
  styleContrastReport,
  styleRules,
  validateSiteStyle,
  type SiteColors,
  type SiteStyle,
  type StyleContrastSurface,
  type StyleTarget,
} from './site-styles.js';
import type { Block, BlockType, FieldDefinition } from './types.js';

export interface BlockPart {
  /** Stable name, unique within the block type: a-z, 0-9 and _ (max 32), starting with a letter. */
  name: string;
  /** Shown in the editor, e.g. "Primary button". */
  label: string;
  /**
   * CSS selector of the part's element(s), relative to the block root, e.g.
   * `.block-hero-heading` or `a`. Simple selectors only: tags, classes,
   * attributes, structural pseudo-classes and combinators (see
   * `blockPartSelectorError`). In a container block, anchor it with `>` so it
   * never reaches a nested block's elements.
   */
  selector: string;
  /** The kind of style that fits the part; pickers and checks list only styles with this target. */
  target: StyleTarget;
  /**
   * The block's own `style` field that already chooses this part's style per
   * instance (e.g. core/heading `eyebrow_style_id`). `part_styles` does not
   * take such a part; a site-wide part style still applies when the field is
   * empty.
   */
  style_field?: string;
  /** Text colour the block's CSS gives the part (a colour token), for contrast checks. Default: `text`. */
  color?: string;
  /** Background the block's CSS puts behind the part (a colour token), for contrast checks. Default: the site background. */
  background?: string;
  /** Block field holding the instance's background colour behind the part (e.g. core/hero `background`). */
  background_field?: string;
  /** The part holds no text of its own (an overlay, a layout wrapper): its style is not checked for text contrast. */
  decorative?: boolean;
  /** The part exists from this render version (older output has no such element). */
  min_render_version?: number;
}

export const BLOCK_PART_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_BLOCK_PARTS = 16;
export const PART_STYLES_FIELD = 'part_styles';

/** The field every block type with instance-stylable parts gets. */
export const PART_STYLES_FIELD_DEFINITION: FieldDefinition = {
  name: PART_STYLES_FIELD,
  type: 'part_styles',
  label: 'Part styles',
  help: 'A named style for parts of this block. Empty uses the site-wide style for the part, if any, else the block\'s own look.',
  editor_group: 'appearance',
};

const ATTRIBUTE = String.raw`\[[a-z][a-z0-9_-]*(?:[~|^$*]?="[\w./:#-]*")?\]`;
const PSEUDO = String.raw`:(?:first-child|last-child|first-of-type|last-of-type|only-child|only-of-type|(?:nth-child|nth-of-type|nth-last-child)\((?:odd|even|-?\d*n(?:[+-]\d+)?|\d+)\))`;
const COMPOUND = new RegExp(String.raw`^(?:[a-z][a-z0-9-]*)?(?:\.[a-zA-Z_][\w-]*|${ATTRIBUTE}|${PSEUDO})*$`);
const MAX_SELECTOR_LENGTH = 200;

/**
 * Why a part selector is unsafe or unsupported, or null. Generated CSS
 * embeds it inside `:where(…)`, so it must be plain selector text: no
 * braces, at-rules, comments, escapes, pseudo-elements or state
 * pseudo-classes (hover and focus come from the style), at most four
 * comma-separated selectors of at most six compounds.
 */
export function blockPartSelectorError(selector: unknown): string | null {
  if (typeof selector !== 'string' || !selector.trim()) return 'selector is required';
  if (selector.length > MAX_SELECTOR_LENGTH) return `selector is limited to ${MAX_SELECTOR_LENGTH} characters`;
  if (/[{};@\\<'`]|\/\*|::/.test(selector)) return 'selector may not contain braces, ";", "@", "\\", comments, markup or pseudo-elements';
  const items = selector.split(',');
  if (items.length > 4) return 'selector lists at most four selectors';
  for (const item of items) {
    const tokens = selectorTokens(item);
    if (!tokens.length) return 'selector has an empty item';
    let compounds = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (['>', '+', '~'].includes(token)) {
        if (index === 0 || index === tokens.length - 1 || ['>', '+', '~'].includes(tokens[index - 1]!)) return `selector "${item.trim()}" has a combinator without an element on both sides`;
        continue;
      }
      if (!token || !COMPOUND.test(token)) return `selector "${item.trim()}" uses "${token}": write tags, .classes, [attributes] and structural pseudo-classes such as :first-child`;
      compounds += 1;
    }
    if (compounds > 6) return `selector "${item.trim()}" nests more than six levels`;
  }
  return null;
}

/** Compounds and combinators of one selector, splitting only outside () and []. */
function selectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let current = '', depth = 0;
  const flush = () => { if (current) tokens.push(current); current = ''; };
  for (const char of selector.trim()) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (depth === 0 && /\s/.test(char)) { flush(); continue; }
    if (depth === 0 && (char === '>' || char === '+' || char === '~')) { flush(); tokens.push(char); continue; }
    current += char;
  }
  flush();
  return tokens;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Problems in a block type's `parts`, each as `[path, message]` with a
 * JSON-pointer path. `schema` is the type's fields, for `style_field` and
 * `background_field`.
 */
export function blockPartsProblems(parts: unknown, schema: readonly FieldDefinition[]): Array<[string, string]> {
  if (parts === undefined) return [];
  if (!Array.isArray(parts)) return [['/parts', 'parts must be a list of { name, label, selector, target }.']];
  const problems: Array<[string, string]> = [];
  if (parts.length > MAX_BLOCK_PARTS) problems.push(['/parts', `A block type declares at most ${MAX_BLOCK_PARTS} parts.`]);
  const names = new Set<string>();
  const known = new Set(['name', 'label', 'selector', 'target', 'style_field', 'color', 'background', 'background_field', 'decorative', 'min_render_version']);
  parts.forEach((part, index) => {
    const at = `/parts/${index}`;
    if (!isRecord(part)) { problems.push([at, 'Each part must be an object with name, label, selector and target.']); return; }
    for (const key of Object.keys(part)) if (!known.has(key)) problems.push([`${at}/${key}`, `Unknown part property "${key}".`]);
    if (typeof part.name !== 'string' || !BLOCK_PART_NAME_PATTERN.test(part.name)) problems.push([`${at}/name`, 'Part names are lowercase letters, digits and "_" (max 32), starting with a letter.']);
    else if (names.has(part.name)) problems.push([`${at}/name`, `Part "${part.name}" appears twice.`]);
    else names.add(part.name);
    if (typeof part.label !== 'string' || !part.label.trim() || part.label.length > 60) problems.push([`${at}/label`, 'label must be text up to 60 characters.']);
    const selectorError = blockPartSelectorError(part.selector);
    if (selectorError) problems.push([`${at}/selector`, `${selectorError}.`]);
    if (!(STYLE_TARGETS as readonly unknown[]).includes(part.target)) problems.push([`${at}/target`, `target must be one of ${STYLE_TARGETS.join(', ')}.`]);
    if (part.style_field !== undefined && !schema.some(field => field.name === part.style_field && field.type === 'style')) problems.push([`${at}/style_field`, 'style_field must name a style field of this block type.']);
    if (part.background_field !== undefined && !schema.some(field => field.name === part.background_field && field.type === 'color')) problems.push([`${at}/background_field`, 'background_field must name a colour field of this block type.']);
    for (const key of ['color', 'background'] as const) {
      if (part[key] !== undefined && !(COLOR_TOKENS as readonly unknown[]).includes(part[key])) problems.push([`${at}/${key}`, `${key} must be a colour token (${COLOR_TOKENS.join(', ')}).`]);
    }
    if (part.decorative !== undefined && typeof part.decorative !== 'boolean') problems.push([`${at}/decorative`, 'decorative must be true or false.']);
    if (part.min_render_version !== undefined && (!Number.isInteger(part.min_render_version) || (part.min_render_version as number) < 1)) problems.push([`${at}/min_render_version`, 'min_render_version must be a whole number from 1.']);
  });
  return problems;
}

/** Parts of a type that exist at a render version. */
export function blockPartsAt(type: Pick<BlockType, 'parts'>, renderVersion?: number): BlockPart[] {
  const version = resolveRenderVersion(renderVersion);
  return (type.parts ?? []).filter(part => !part.min_render_version || part.min_render_version <= version);
}

/** Parts an instance chooses through `part_styles`: those without a style field of their own. */
export function instanceStyleParts(type: Pick<BlockType, 'parts'>, renderVersion?: number): BlockPart[] {
  return blockPartsAt(type, renderVersion).filter(part => !part.style_field);
}

/** The type's schema with the `part_styles` field when it has parts an instance can style. */
export function withPartStylesField<T extends Pick<BlockType, 'parts' | 'schema'>>(type: T): T {
  const needs = (type.parts ?? []).some(part => !part.style_field);
  const has = type.schema.some(field => field.name === PART_STYLES_FIELD);
  if (needs === has) return type;
  return { ...type, schema: needs ? [...type.schema, PART_STYLES_FIELD_DEFINITION] : type.schema.filter(field => field.name !== PART_STYLES_FIELD) };
}

/** `core/rich_heading.link`. */
export function blockPartRef(typeId: string, part: string): string {
  return `${typeId}.${part}`;
}

/** `{ type, part }` for a `<block type>.<part>` reference, or null. */
export function parseBlockPartRef(ref: string): { type: string; part: string } | null {
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) return null;
  return { type: ref.slice(0, dot), part: ref.slice(dot + 1) };
}

type Registry = ReadonlyMap<string, BlockType> | Record<string, BlockType>;
const lookup = (registry: Registry, id: string): BlockType | undefined => registry instanceof Map ? registry.get(id) : (registry as Record<string, BlockType>)[id];
const registryTypes = (registry: Registry): BlockType[] => registry instanceof Map ? [...registry.values()] : Object.values(registry as Record<string, BlockType>);

/** Every declared part in a registry, keyed by reference. */
export function blockPartIndex(registry: Registry): Map<string, { type: BlockType; part: BlockPart }> {
  const index = new Map<string, { type: BlockType; part: BlockPart }>();
  for (const type of registryTypes(registry)) for (const part of type.parts ?? []) index.set(blockPartRef(type.id, part.name), { type, part });
  return index;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NOT_STYLED = ':not([class^="s-"],[class*=" s-"])';
const BOOST = ':not(#\\#):not(#\\#)';

/**
 * The selector a part style uses: site-wide (`instanceStyle` omitted), or
 * for instances that chose `instanceStyle` for the part. Null when the type
 * or part cannot be addressed safely.
 */
export function blockPartSelector(type: Pick<BlockType, 'name'>, part: BlockPart, instanceStyle?: string): string | null {
  if (!NAME.test(type.name) || !BLOCK_PART_NAME_PATTERN.test(part.name) || blockPartSelectorError(part.selector)) return null;
  if (instanceStyle !== undefined && !STYLE_ID_PATTERN.test(instanceStyle)) return null;
  const scope = `[data-block="${type.name}"]${instanceStyle === undefined ? `:not([data-part-${part.name}])` : `[data-part-${part.name}="${instanceStyle}"]`}`;
  const list = part.selector.split(',').map(item => `${scope} ${item.trim().replace(/\s+/g, ' ')}`).join(',');
  return `:where(${list})${NOT_STYLED}${BOOST}`;
}

/** The valid `part_styles` of an instance: part name → style id, for parts the instance may style. */
export function instancePartStyles(type: Pick<BlockType, 'parts'>, data: unknown, renderVersion?: number): Array<[BlockPart, string]> {
  const parts = instanceStyleParts(type, renderVersion);
  // A type without instance parts has no part_styles field; never read the key.
  if (!parts.length) return [];
  const value = isRecord(data) ? data[PART_STYLES_FIELD] : undefined;
  if (!isRecord(value)) return [];
  return parts.flatMap(part => {
    const id = value[part.name];
    return typeof id === 'string' && STYLE_ID_PATTERN.test(id) ? [[part, id] as [BlockPart, string]] : [];
  });
}

/** Root attributes that mark an instance's own part styles (`data-part-<part>="<style id>"`). Empty without choices. */
export function partStyleAttributes(type: Pick<BlockType, 'parts'>, data: unknown, renderVersion?: number): Record<string, string> {
  return Object.fromEntries(instancePartStyles(type, data, renderVersion).map(([part, id]) => [`data-part-${part.name}`, id]));
}

const isClassStyle = (style: SiteStyle) => !(STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role ?? '');
/** Whether a style may be chosen for a part. */
export function styleFitsPart(style: Pick<SiteStyle, 'role' | 'targets'>, part: Pick<BlockPart, 'target'>): boolean {
  return isClassStyle(style as SiteStyle) && style.targets.includes(part.target);
}

export interface BlockPartStylesCssOptions {
  /** The site style library (re-validated: stored data is rendered into a <style> element). */
  styles: readonly unknown[] | undefined;
  breakpoints: BreakpointWidths;
  renderVersion?: number;
}

/** Instance part choices in a tree: blocks, their children and slots, and repeater item data. */
function collectInstanceChoices(blocks: readonly Block[], registry: Registry, renderVersion: number | undefined, out: Map<string, { type: BlockType; part: BlockPart; style: string }>, depth = 0): void {
  if (depth > 50) return;
  const add = (type: BlockType | undefined, data: unknown) => {
    if (!type?.parts?.length) return;
    for (const [part, style] of instancePartStyles(type, data, renderVersion)) out.set(`${type.id}|${part.name}|${style}`, { type, part, style });
  };
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = lookup(registry, block.type);
    add(type, block.data);
    // Repeater items render as their item block with item_overrides merged in.
    const itemId = block.data?.item_block ?? type?.expand_to?.defaults?.item_block;
    const itemType = typeof itemId === 'string' ? lookup(registry, itemId) : undefined;
    if (itemType?.parts?.length) {
      add(itemType, block.data?.item_overrides);
      if (Array.isArray(block.data?.items)) for (const row of block.data.items as unknown[]) add(itemType, row);
    }
    if (Array.isArray(block.children)) collectInstanceChoices(block.children, registry, renderVersion, out, depth + 1);
    if (Array.isArray(block.slots)) for (const slot of block.slots) if (Array.isArray(slot)) collectInstanceChoices(slot, registry, renderVersion, out, depth + 1);
  }
}

/**
 * CSS for block part styles on one page: the site-wide part styles of the
 * block types in `typeIds`, and the part styles the blocks in `blocks`
 * chose. Empty when the site sets none, so existing output is unchanged.
 * Emitted with the block CSS (`collectBlockAssets`), on published pages
 * and in previews alike.
 */
export function blockPartStylesCss(blocks: readonly Block[], registry: Registry, typeIds: Iterable<string>, opts: BlockPartStylesCssOptions): string {
  const styles = (Array.isArray(opts.styles) ? opts.styles : []).flatMap(value => validateSiteStyle(value).style ?? []).filter(isClassStyle);
  if (!styles.length) return '';
  const byId = new Map(styles.map(style => [style.id, style]));
  const present = new Set(typeIds);
  const rules: string[] = [];
  for (const style of styles) {
    for (const ref of style.parts ?? []) {
      const parsed = parseBlockPartRef(ref);
      if (!parsed || !present.has(parsed.type)) continue;
      const type = lookup(registry, parsed.type);
      const part = type && blockPartsAt(type, opts.renderVersion).find(candidate => candidate.name === parsed.part);
      if (!type || !part || !styleFitsPart(style, part)) continue;
      const selector = blockPartSelector(type, part);
      if (selector) rules.push(...styleRules(style, [selector], opts.breakpoints));
    }
  }
  const choices = new Map<string, { type: BlockType; part: BlockPart; style: string }>();
  collectInstanceChoices(blocks, registry, opts.renderVersion, choices);
  for (const { type, part, style: id } of [...choices.values()].sort((a, b) => `${a.type.id}|${a.part.name}|${a.style}`.localeCompare(`${b.type.id}|${b.part.name}|${b.style}`))) {
    const style = byId.get(id);
    if (!style || !styleFitsPart(style, part)) continue;
    const selector = blockPartSelector(type, part, id);
    if (selector) rules.push(...styleRules(style, [selector], opts.breakpoints));
  }
  return rules.join('\n');
}

// ── Checks ──────────────────────────────────────────────────────────────

/** How a part's text is read, for the contrast it needs; null for parts without text. */
export function partTextUse(part: Pick<BlockPart, 'target' | 'decorative'>): TextUse | null {
  if (part.target === 'image' || part.decorative) return null;
  return part.target === 'heading' || part.target === 'button' ? 'content' : 'body';
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Where a part's text sits, for `styleContrastReport({ surfaces })`: the
 * part's own colours, or the instance's background field when it is set.
 * Null for parts without text.
 */
export function partContrastSurface(type: Pick<BlockType, 'id'>, part: BlockPart, data?: Record<string, unknown>): StyleContrastSurface | null {
  const use = partTextUse(part);
  if (!use) return null;
  const instanceBackground = part.background_field ? data?.[part.background_field] : undefined;
  const background = typeof instanceBackground === 'string' && HEX.test(instanceBackground.trim()) ? instanceBackground.trim() : part.background;
  return { label: blockPartRef(type.id, part.name), use, ...(part.color ? { color: part.color } : {}), ...(background ? { background } : {}) };
}

/** Contrast surfaces of the parts a site-wide style applies to. */
export function stylePartSurfaces(style: Pick<SiteStyle, 'parts'>, registry: Registry): StyleContrastSurface[] {
  const index = blockPartIndex(registry);
  return (style.parts ?? []).flatMap(ref => {
    const found = index.get(ref);
    const surface = found && partContrastSurface(found.type, found.part);
    return surface ? [surface] : [];
  });
}

/**
 * Why a style's `parts` cannot be saved on this site: a reference no block
 * type declares (with the closest ones), or a part whose kind the style does
 * not target.
 */
export function stylePartErrors(style: Pick<SiteStyle, 'name' | 'targets' | 'parts' | 'role'>, registry: Registry): string[] {
  if (!style.parts?.length) return [];
  const index = blockPartIndex(registry);
  const errors: string[] = [];
  for (const ref of style.parts) {
    const found = index.get(ref);
    if (!found) {
      const parsed = parseBlockPartRef(ref);
      const type = parsed && lookup(registry, parsed.type);
      const suggestions = type?.parts?.length ? closestFieldNames(parsed!.part, type.parts.map(part => part.name)).map(name => blockPartRef(type.id, name)) : closestFieldNames(ref, index.keys());
      const own = type?.parts?.length ? ` ${type.id} has the parts ${type.parts.map(part => part.name).join(', ')}.` : type ? ` ${type.id} declares no parts.` : '';
      errors.push(`parts: ${ref} is not a block part.${own}${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ' read_block_type lists a block\'s parts.'}`);
      continue;
    }
    if (!style.targets.includes(found.part.target)) errors.push(`parts: ${ref} is a ${found.part.target} part, and ${style.name} does not target ${found.part.target}. Add "${found.part.target}" to its targets.`);
  }
  return errors;
}

export interface PartStyleIssue {
  code: 'unknown_style' | 'style_target_mismatch' | 'part_style_contrast';
  block_id?: string;
  block_type: string;
  /** e.g. `data.part_styles.link` */
  path: string;
  part: string;
  style_id: string;
  /** Styles that fit the part, closest first. */
  suggestions?: string[];
  message: string;
}

export interface PartStyleCheckOptions {
  /** Path prefix of the block data, e.g. `data` or `blocks[2].data`. */
  path?: string;
  /** Contrast: the site palette and render version. Without it, contrast is not checked. */
  contrast?: { colors: SiteColors; renderVersion?: number };
}

/**
 * What is wrong with an instance's `part_styles` against the site's styles:
 * a style id the library does not have or one of another kind (errors, with
 * the styles that fit), and, with `contrast`, text that is unreadable on the
 * part's background. Unknown part names are `unknown_field`
 * (block-unknown-fields.ts) and malformed values `field_type_mismatch`
 * (block-field-types.ts). Contrast results below APCA that meet WCAG 2 AA are
 * warnings; failing both is an error, as for saving a style.
 */
export function partStyleIssues(
  block: { id?: unknown; type: string; data?: unknown },
  type: BlockType,
  styles: readonly SiteStyle[],
  options: PartStyleCheckOptions = {},
): { errors: PartStyleIssue[]; warnings: PartStyleIssue[] } {
  const errors: PartStyleIssue[] = [];
  const warnings: PartStyleIssue[] = [];
  const data = isRecord(block.data) ? block.data : {};
  const blockId = typeof block.id === 'string' && block.id ? block.id : undefined;
  const base = options.path ?? 'data';
  const byId = new Map(styles.map(style => [style.id, style]));
  // Every part a choice can name, including parts newer render versions add.
  for (const [part, id] of instancePartStyles(type, data, LATEST_RENDER_VERSION)) {
    const path = `${base}.${PART_STYLES_FIELD}.${part.name}`;
    const issue = { ...(blockId ? { block_id: blockId } : {}), block_type: type.id, path, part: part.name, style_id: id };
    const fitting = styles.filter(style => styleFitsPart(style, part)).map(style => style.id);
    const style = byId.get(id);
    if (!style) {
      const suggestions = closestFieldNames(id, fitting);
      errors.push({ ...issue, code: 'unknown_style', suggestions: suggestions.length ? suggestions : fitting.slice(0, 3), message: `${path}: the site has no style "${id}".${fitting.length ? ` ${part.target} styles: ${(suggestions.length ? suggestions : fitting.slice(0, 5)).join(', ')}.` : ` Create a style that targets ${part.target} first (create_style).`}` });
      continue;
    }
    if (!styleFitsPart(style, part)) {
      errors.push({ ...issue, code: 'style_target_mismatch', suggestions: fitting.slice(0, 3), message: `${path}: "${id}" is not a ${part.target} style (it targets ${style.targets.join(', ') || 'nothing'}).${fitting.length ? ` ${part.target} styles: ${fitting.slice(0, 5).join(', ')}.` : ` Add "${part.target}" to its targets.`}` });
      continue;
    }
    const surface = options.contrast && partContrastSurface(type, part, data);
    if (surface && options.contrast) {
      const report = styleContrastReport(style, options.contrast.colors, { renderVersion: options.contrast.renderVersion, surfaces: [surface], surfacesOnly: true });
      for (const message of report.errors) errors.push({ ...issue, code: 'part_style_contrast', message: `${path}: ${message}` });
      for (const message of report.warnings) warnings.push({ ...issue, code: 'part_style_contrast', message: `${path}: ${message}` });
    }
  }
  return { errors, warnings };
}

/** Part style issues anywhere in a block tree (warnings for tree writes). */
export function treePartStyleIssues(value: unknown, registry: Registry, styles: readonly SiteStyle[], options: Omit<PartStyleCheckOptions, 'path'> = {}, root = 'blocks'): PartStyleIssue[] {
  const out: PartStyleIssue[] = [];
  const visit = (node: unknown, path: string, depth: number) => {
    if (!Array.isArray(node) || depth > 50) return;
    node.forEach((block, index) => {
      if (!isRecord(block) || typeof block.type !== 'string') return;
      const at = `${path}[${index}]`;
      const type = lookup(registry, block.type);
      if (type?.parts?.length) {
        const issues = partStyleIssues(block as { type: string }, type, styles, { ...options, path: `${at}.data` });
        out.push(...issues.errors, ...issues.warnings);
      }
      visit(block.children, `${at}.children`, depth + 1);
      if (Array.isArray(block.slots)) block.slots.forEach((slot, s) => visit(slot, `${at}.slots[${s}]`, depth + 1));
    });
  };
  visit(value, root, 0);
  return out;
}
