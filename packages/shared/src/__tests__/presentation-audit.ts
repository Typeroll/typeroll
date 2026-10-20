// Which presentational declarations in a core block's CSS a site can change.
//
// Used by presentation-settings.test.ts ("every presentational declaration a
// core block writes is reachable") and by the block parts guide
// (docs/plans/block-parts.md), which tells agents to run it when they declare
// parts. A declaration is reachable when its value reads a variable (a field
// or setting sets it), or when every element it styles in the block's sample
// markup is one a style reaches and a style property sets that property:
//
// - a declared part (`BlockType.parts`), through part styles;
// - the element a block's `style_id` lands on (`style_element_class`, else
//   the root);
// - the root's block margins, through `style_overrides.spacing_before/after`.
//
// Focus indicators (selectors with :focus) are not counted: they stay the
// platform's, so no style can remove them.
import { Window } from 'happy-dom';
import {
  blockOutputForVersion,
  blockPartsAt,
  renderBlocks,
  type Block,
  type BlockType,
  type RenderContext,
} from '../index.js';

/** Properties whose value is a visible opinion of the block. */
const PRESENTATIONAL = /^(?:font-size|font-weight|font-family|font-style|line-height|letter-spacing|text-transform|text-decoration(?:-line|-color|-thickness)?|text-underline-offset|color|background|background-color|border(?:-(?:top|right|bottom|left|width|style|color|radius|block|inline)(?:-(?:width|style|color))?)?|border-radius|box-shadow|opacity|gap|row-gap|column-gap|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?)$/;
/** Values that state no opinion. */
const NEUTRAL = new Set(['0', 'inherit', 'initial', 'unset', 'currentcolor', 'transparent', 'auto']);
/** Properties a style (StyleProps) sets. */
const STYLE_SETS = /^(?:font-size|font-weight|font-family|font-style|line-height|letter-spacing|text-transform|text-decoration(?:-line)?|text-underline-offset|color|background|background-color|border(?:-(?:top|right|bottom|left|width|style|color|block|inline))?|border-radius|box-shadow|opacity|gap|row-gap|column-gap|margin(?:-(?:top|bottom|block(?:-start|-end)?))?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?)$/;
/** Root properties `style_overrides.spacing_before/after` set. */
const SPACING = /^margin(?:-(?:top|bottom|block(?:-start|-end)?))?$/;

export interface CssDeclaration {
  /** One selector of the rule (comma lists are split). */
  selector: string;
  property: string;
  value: string;
}

/** Flat declarations of a stylesheet; @media/@supports bodies are read, @keyframes skipped. */
export function cssDeclarations(css: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (text: string) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf('{', index);
      if (open < 0) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1, end = open + 1;
      while (end < text.length && depth) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; }
      const body = text.slice(open + 1, end - 1);
      if (prelude.startsWith('@')) { if (/^@(?:media|supports|container)\b/.test(prelude)) walk(body); }
      else {
        const selectors = splitList(prelude);
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon < 0) continue;
          const property = part.slice(0, colon).trim().toLowerCase();
          const value = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
          if (!property || !value) continue;
          for (const selector of selectors) out.push({ selector, property, value });
        }
      }
      index = end;
    }
  };
  walk(source);
  return out;
}

/** Split a selector list on top-level commas. */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < list.length; i++) {
    const char = list[i]!;
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) { out.push(list.slice(start, i).trim().replace(/\s+/g, ' ')); start = i + 1; }
  }
  out.push(list.slice(start).trim().replace(/\s+/g, ' '));
  return out.filter(Boolean);
}

/** A selector without state: attribute filters (except the block scope), pseudo-classes and pseudo-elements removed. */
function structural(selector: string): string {
  let out = selector.replace(/\[(?:[^\]"']|"[^"]*"|'[^']*')*\]/g, match => /^\[data-block=/.test(match) ? match : '');
  for (let previous = ''; previous !== out;) { previous = out; out = out.replace(/::?[\w-]+(?:\([^()]*\))?/g, ''); }
  return out.replace(/\s*([>+~])\s*/g, ' $1 ').replace(/(?:^|\s)[>+~](?=\s*$)/g, '').replace(/^\s*[>+~]\s*/, '').replace(/\s+/g, ' ').trim();
}

export function isLiteralPresentation({ property, value }: Pick<CssDeclaration, 'property' | 'value'>): boolean {
  if (!PRESENTATIONAL.test(property)) return false;
  if (value.includes('var(')) return false;
  const bare = value.replace(/\s*!important$/i, '').trim().toLowerCase();
  return !bare.split(/\s+/).every(token => NEUTRAL.has(token) || /^0(?:px|rem|em|%)?$/.test(token));
}

/** The key an allowlist entry uses: `selector { property: value }`. */
export const declarationKey = (d: CssDeclaration) => `${d.selector} { ${d.property}: ${d.value} }`;

export interface SampleDom {
  root: Element;
  container: Element;
}

/** The block's sample markup in a document. */
export function sampleDom(block: Block, registry: Map<string, BlockType>, renderVersion: number): SampleDom | null {
  const window = new Window();
  const container = window.document.createElement('div');
  container.innerHTML = renderBlocks([block], { registry, renderVersion, context: PART_SAMPLE_CONTEXTS[block.type] });
  const root = container.firstElementChild as unknown as Element | null;
  return root ? { root, container: container as unknown as Element } : null;
}

/** Elements in the sample that a style reaches: declared parts and the style element. */
function styledElements(type: BlockType, dom: SampleDom, renderVersion: number): { parts: Set<Element>; styleElement: Element | null } {
  const parts = new Set<Element>();
  for (const part of blockPartsAt(type, renderVersion)) for (const element of dom.root.querySelectorAll(part.selector)) parts.add(element);
  const hasStyleField = type.schema.some(field => field.type === 'style' && field.name === 'style_id');
  const styleElement = !hasStyleField ? null
    : type.style_element_class ? dom.root.querySelector(`.${type.style_element_class}`) ?? null : dom.root;
  return { parts, styleElement };
}

/**
 * The block's literal presentational declarations at a render version that no
 * field, style or variable reaches.
 */
export function unreachablePresentation(type: BlockType, block: Block, registry: Map<string, BlockType>, renderVersion: number): CssDeclaration[] {
  const css = blockOutputForVersion(type, renderVersion).styles ?? '';
  const dom = sampleDom(block, registry, renderVersion);
  const styled = dom ? styledElements(type, dom, renderVersion) : { parts: new Set<Element>(), styleElement: null };
  const out: CssDeclaration[] = [];
  const seen = new Set<string>();
  for (const declaration of cssDeclarations(css)) {
    // Focus indicators stay the platform's: a style never replaces them.
    if (!isLiteralPresentation(declaration) || /:focus/.test(declaration.selector)) continue;
    let matched: Element[] = [];
    const query = structural(declaration.selector);
    if (dom && query) {
      try { matched = [...dom.container.querySelectorAll(query)]; } catch { matched = []; }
    }
    const reachable = matched.length > 0 && matched.every(element =>
      (STYLE_SETS.test(declaration.property) && (styled.parts.has(element) || element === styled.styleElement))
      || (element === dom?.root && SPACING.test(declaration.property)));
    if (reachable) continue;
    const key = declarationKey(declaration);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(declaration);
  }
  return out;
}

/**
 * Data that renders every part of a block. A block that declares parts adds
 * an entry here, so the part guards see each part element.
 */
export const PART_SAMPLES: Record<string, Record<string, unknown>> = {
  'core/rich_heading': { level: 'h2', html: 'Read <a href="/guide/">the guide</a>' },
  'core/heading': { level: 'h2', eyebrow: 'Eyebrow', text: 'Heading', subtitle: 'Subtitle' },
  'core/button': { label: 'Get started', href: '/start/' },
  'core/hero': {
    eyebrow: 'Eyebrow', heading: 'Heading', subheading: '<p>Subheading</p>', image: '/media/hero.jpg',
    primary_label: 'Start', primary_url: '/start/', secondary_label: 'More', secondary_url: '/more/',
  },
  'form/radio_group': { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  'form/checkbox_group': { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  'form/help': { body: '<p>See <a href="/help/">the guide</a></p>' },
  'core/field_list': { title: 'Facts', fields: [{ field: 'city' }, { field: 'website' }, { field: 'tags' }] },
};

/** Render context a block's sample needs besides its data (a field list reads the Page's fields). */
export const PART_SAMPLE_CONTEXTS: Record<string, RenderContext> = {
  'core/field_list': {
    content_type: { fields: [
      { name: 'city', type: 'text', label: 'City' },
      { name: 'website', type: 'url', label: 'Website' },
      { name: 'tags', type: 'multiselect', label: 'Tags', options: ['a', 'b'] },
    ] },
    page: { fields: { city: 'Stockholm', website: 'https://example.com/', tags: ['a', 'b'] } },
  },
};

/** A sample block: field defaults, required fields filled in, then PART_SAMPLES. */
export function partSampleBlock(type: BlockType): Block {
  const data: Record<string, unknown> = {};
  for (const field of type.schema) {
    if (field.default !== undefined) data[field.name] = field.default;
    else if (field.required) data[field.name] = field.type === 'richtext' ? '<p>Sample <a href="/link/">link</a></p>' : field.type === 'url' ? '/sample/' : field.type === 'image' ? '/media/sample.jpg' : `Sample ${field.name}`;
  }
  Object.assign(data, PART_SAMPLES[type.id] ?? {});
  const block: Block = { id: 'sample', type: type.id, data };
  if (type.container === true) block.children = [{ id: 'sample-child', type: 'core/prose', data: { html: '<p>Child</p>' } }];
  if (type.container === 'slots') block.slots = Array.from({ length: type.slot_count ?? type.slot_labels?.length ?? 2 }, (_, index) => [{ id: `sample-slot-${index}`, type: 'core/prose', data: { html: '<p>Slot</p>' } }]);
  return block;
}
