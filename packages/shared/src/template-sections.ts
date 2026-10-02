/**
 * Sections in block templates beyond the original `{{#field}}…{{/field}}`:
 *
 * - `{{#each items}}…{{/each}}` repeats its body for every item of an array.
 *   Names resolve against the item first, then the block. `{{@index}}`
 *   (0-based), `{{@number}}` (1-based), `{{@first}}` and `{{@last}}` describe
 *   the position.
 * - `{{^field}}…{{/field}}` renders when the value is empty (missing, empty
 *   string, empty array or false): the else of `{{#field}}`.
 * - `{{#link field class="…"}}…{{/link}}` wraps its body in `<a>` when the
 *   link field resolves to an href, and renders the body alone otherwise.
 *
 * Templates without these constructs never reach this module, so their
 * output is unchanged. A template that does use them is parsed into a tree;
 * the text between section tags is substituted by the regular field pass.
 */

import { safeLinkHref } from './article-blocks.js';

export type SectionNode =
  | { kind: 'text'; text: string }
  | { kind: 'section'; name: string; inverted: boolean; body: SectionNode[] }
  | { kind: 'each'; name: string; body: SectionNode[] }
  | { kind: 'link'; name: string; className: string; body: SectionNode[] };

export interface SectionParseError {
  message: string;
  /** Character offset of the offending tag. */
  index: number;
}

const TAG = /\{\{\s*([#^/])\s*([^{}]*?)\s*\}\}/g;
const NAME = /^@?[A-Za-z_][\w.-]*$/;
const POSITION = /\{\{\s*@(index|number|first|last)\s*\}\}/g;

/** True when the template uses a construct this module handles. */
export function usesExtendedSections(template: string): boolean {
  return /\{\{\s*(?:#\s*(?:each|link)\s|\^)/.test(template);
}

type OpenFrame = { node: Extract<SectionNode, { body: SectionNode[] }>; close: string; index: number };

/** Parse a template into section nodes, or report the first structural error. */
export function parseSections(template: string): { nodes: SectionNode[]; error?: undefined } | { nodes?: undefined; error: SectionParseError } {
  const root: SectionNode[] = [];
  const stack: OpenFrame[] = [];
  const current = () => stack.length ? stack[stack.length - 1]!.node.body : root;
  let last = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(template); match; match = TAG.exec(template)) {
    const [whole, sigil, rawBody] = match as unknown as [string, string, string];
    if (match.index > last) current().push({ kind: 'text', text: template.slice(last, match.index) });
    last = match.index + whole.length;
    const body = rawBody.trim();
    if (sigil === '/') {
      const frame = stack.pop();
      if (!frame) return { error: { message: `{{/${body}}} closes nothing`, index: match.index } };
      if (frame.close !== body) return { error: { message: `{{/${body}}} closes {{${frame.node.kind === 'section' && frame.node.inverted ? '^' : '#'}${frame.close === 'each' || frame.close === 'link' ? `${frame.close} ${frame.node.name}` : frame.close}}}; close it with {{/${frame.close}}} first`, index: match.index } };
      continue;
    }
    if (sigil === '#' && /^each\s/.test(body)) {
      const name = body.slice(4).trim();
      if (!NAME.test(name)) return { error: { message: `{{#each ${name}}} needs a field name`, index: match.index } };
      const node: SectionNode = { kind: 'each', name, body: [] };
      current().push(node);
      stack.push({ node, close: 'each', index: match.index });
      continue;
    }
    if (sigil === '#' && /^link\s/.test(body)) {
      const parts = /^link\s+(@?[A-Za-z_][\w.-]*)(?:\s+class="([^"<>]*)")?$/.exec(body);
      if (!parts) return { error: { message: `{{#${body}}} must be {{#link field}} or {{#link field class="…"}}`, index: match.index } };
      const node: SectionNode = { kind: 'link', name: parts[1]!, className: parts[2] ?? '', body: [] };
      current().push(node);
      stack.push({ node, close: 'link', index: match.index });
      continue;
    }
    if (!NAME.test(body)) return { error: { message: `{{${sigil}${body}}} is not a section tag`, index: match.index } };
    const node: SectionNode = { kind: 'section', name: body, inverted: sigil === '^', body: [] };
    current().push(node);
    stack.push({ node, close: body, index: match.index });
  }
  if (stack.length) {
    const open = stack[stack.length - 1]!;
    return { error: { message: `{{${open.node.kind === 'section' && open.node.inverted ? '^' : '#'}${open.close === 'each' || open.close === 'link' ? `${open.close} ${open.node.name}` : open.close}}} is never closed`, index: open.index } };
  }
  if (last < template.length) root.push({ kind: 'text', text: template.slice(last) });
  return { nodes: root };
}

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const filled = (value: unknown) => Array.isArray(value) ? value.length > 0 : Boolean(value);

/**
 * Render parsed sections. `renderText` substitutes `{{field}}` tokens in a
 * text node against a scope; `resolve` reads a (dotted) name from a scope.
 */
export function renderSections(
  nodes: readonly SectionNode[],
  scope: Record<string, unknown>,
  renderText: (text: string, scope: Record<string, unknown>) => string,
  resolve: (name: string, scope: Record<string, unknown>) => unknown,
): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += renderText(node.text.replace(POSITION, (_m, key: string) => escape(scope[`@${key}`])), scope);
    } else if (node.kind === 'section') {
      if (filled(resolve(node.name, scope)) !== node.inverted) out += renderSections(node.body, scope, renderText, resolve);
    } else if (node.kind === 'each') {
      const items = resolve(node.name, scope);
      if (!Array.isArray(items)) continue;
      items.forEach((item, index) => {
        const itemScope: Record<string, unknown> = {
          ...scope,
          ...(item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : { '.': item }),
          '@index': index, '@number': index + 1, '@first': index === 0, '@last': index === items.length - 1,
        };
        out += renderSections(node.body, itemScope, renderText, resolve);
      });
    } else {
      const value = resolve(node.name, scope);
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const href = typeof record?.href === 'string' ? safeLinkHref(record.href) : typeof value === 'string' ? safeLinkHref(value) : '';
      const inner = renderSections(node.body, scope, renderText, resolve);
      if (!href) { out += inner; continue; }
      const newTab = record?.new_tab === true || record?.target === '_blank';
      out += `<a href="${escape(href)}"${node.className ? ` class="${escape(node.className)}"` : ''}${newTab ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`;
    }
  }
  return out;
}

/** Names a parsed template reads, with the section kind that reads each one. */
export function sectionNames(nodes: readonly SectionNode[]): Array<{ name: string; kind: SectionNode['kind']; depth: number }> {
  const out: Array<{ name: string; kind: SectionNode['kind']; depth: number }> = [];
  const visit = (list: readonly SectionNode[], depth: number) => {
    for (const node of list) {
      if (node.kind === 'text') continue;
      out.push({ name: node.name, kind: node.kind, depth });
      visit(node.body, node.kind === 'each' ? depth + 1 : depth);
    }
  };
  visit(nodes, 0);
  return out;
}
