/**
 * Scope a block type's stylesheet to its own blocks: every selector gets the
 * prefix `[data-block="{name}"]`, so a site block type can never restyle the
 * rest of the page.
 *
 * - `:scope` addresses the block element itself (`:scope > a` styles direct
 *   links); any other selector matches inside the block.
 * - `@media`, `@supports`, `@container` and `@layer` blocks are scoped
 *   recursively; `@keyframes` and `@font-face` pass through, keyframe names
 *   are left to the author.
 * - A selector that already starts with the block's own `[data-block="…"]`
 *   is kept as written, so stylesheets from before scoping keep working.
 * - `html`, `body` and `:root` cannot be scoped and are reported.
 *
 * The scoper is a small tokenizer that respects comments, strings and
 * brackets. It expects CSS that passed checkCustomCss (balanced braces).
 */

export interface ScopedCss {
  css: string;
  /** Selectors that could not be scoped (they target the whole document). */
  rejected: string[];
}

const GROUP_AT_RULES = /^@(?:media|supports|container|layer|document)\b/i;
const OPAQUE_AT_RULES = /^@(?:-[a-z]+-)?(?:keyframes|font-face|page|counter-style|property|font-feature-values)\b/i;
const DOCUMENT_ROOT = /^(?:html|body|:root)(?![\w-])/i;

/** The attribute selector every scoped rule starts with. */
export function blockScopeSelector(name: string): string {
  return `[data-block="${name.replace(/["\\]/g, '')}"]`;
}

/** Split on top-level commas, ignoring commas inside (), [] and strings. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map(part => part.trim()).filter(Boolean);
}

function scopeSelector(selector: string, scope: string, rejected: string[]): string | null {
  if (DOCUMENT_ROOT.test(selector)) { rejected.push(selector); return null; }
  // Already written against the block (`[data-block="name"] .a`): keep it.
  if (selector.startsWith(scope)) return selector;
  if (/^:scope\b/.test(selector)) return scope + selector.slice(':scope'.length);
  if (selector.includes(':scope')) return selector.replace(/:scope\b/g, scope);
  return `${scope} ${selector}`;
}

/** Index of the brace that closes the block opened at `open` (exclusive of strings/comments). */
function matchingBrace(css: string, open: number): number {
  let depth = 0, quote = '';
  for (let i = open; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 1; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return css.length;
}

function scopeRules(css: string, scope: string, rejected: string[]): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    // Copy whitespace and comments verbatim.
    const ws = /^(?:\s+|\/\*[\s\S]*?\*\/)/.exec(css.slice(i));
    if (ws) { out += ws[0]; i += ws[0].length; continue; }
    // Find the next `{` or `;` at top level for this rule's prelude.
    let j = i, quote = '', depth = 0;
    for (; j < css.length; j++) {
      const ch = css[j]!;
      if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && (ch === '{' || ch === ';')) break;
    }
    const prelude = css.slice(i, j).trim();
    if (j >= css.length) { out += css.slice(i); break; }
    if (css[j] === ';') { out += `${prelude};`; i = j + 1; continue; } // @charset, @import (refused earlier), stray
    const close = matchingBrace(css, j);
    const body = css.slice(j + 1, close);
    if (GROUP_AT_RULES.test(prelude)) {
      out += `${prelude}{${scopeRules(body, scope, rejected)}}`;
    } else if (prelude.startsWith('@') || OPAQUE_AT_RULES.test(prelude)) {
      out += `${prelude}{${body}}`;
    } else {
      const selectors = splitSelectors(prelude).map(selector => scopeSelector(selector, scope, rejected)).filter((selector): selector is string => selector !== null);
      if (selectors.length) out += `${selectors.join(',')}{${body}}`;
    }
    i = close + 1;
  }
  return out;
}

/** Scope `css` to blocks of the type named `name`. */
export function scopeBlockCss(css: string, name: string): ScopedCss {
  const rejected: string[] = [];
  return { css: scopeRules(css, blockScopeSelector(name), rejected), rejected };
}
