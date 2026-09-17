import type { Block } from './types.js';

const HTML_H1 = /<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<h1\b([^>]*)>([\s\S]*?)<\/h1\s*>/gi;

/** A final guard for legacy/custom HTML. Do not rewrite comments or raw text. */
export function normalizePageH1s(html: string, keepFirst = true): string {
  let seen = false;
  return html.replace(HTML_H1, (whole, rawText: string | undefined, attrs: string | undefined, content: string) => {
    if (rawText || attrs === undefined) return whole;
    if (keepFirst && !seen) { seen = true; return whole; }
    return `<h2${attrs}>${content}</h2>`;
  });
}

function countHtmlH1s(html: string): number {
  return Array.from(html.matchAll(HTML_H1)).filter(match => match[2] !== undefined).length;
}

function isH1(block: Block): boolean {
  return (['core/heading', 'core/rich_heading'].includes(block.type) && block.data?.level === 'h1')
    || (block.type === 'template/page_title' && (block.data?.level ?? 'h1') === 'h1');
}

export function countBlockH1s(blocks: Block[]): number {
  return blocks.reduce((count, block) => count + Number(isH1(block))
    + (['core/html', 'core/prose'].includes(block.type) ? countHtmlH1s(String(block.data?.html ?? '')) : 0)
    + countBlockH1s(block.children ?? [])
    + (block.slots ?? []).reduce((sum, slot) => sum + countBlockH1s(slot), 0), 0);
}

/** Preserve authored text and IDs; only the duplicate semantic level changes. */
export function demoteBodyH1s(blocks: Block[]): Block[] {
  return blocks.map(block => ({ ...block,
    data: { ...block.data,
      ...(isH1(block) ? { level: 'h2' } : {}),
      ...(['core/html', 'core/prose'].includes(block.type) && typeof block.data?.html === 'string'
        ? { html: normalizePageH1s(block.data.html, false) } : {}),
    },
    ...(block.children ? { children: demoteBodyH1s(block.children) } : {}),
    ...(block.slots ? { slots: block.slots.map(demoteBodyH1s) } : {}),
  }));
}

export function pageHeadingError(body: { blocks?: Block[]; content_mode?: string; html_content?: string }, templateBlocks: Block[] = []): string | null {
  const bodyCount = body.content_mode === 'html'
    ? countHtmlH1s(body.html_content ?? '') : countBlockH1s(body.blocks ?? []);
  const templateCount = body.content_mode === 'html' ? 0 : countBlockH1s(templateBlocks);
  if (templateCount && bodyCount) return 'The Page template already provides the H1. Change body H1 headings to H2 or remove the duplicate title before saving.';
  if (bodyCount > 1) return 'A Page should have one H1. Keep the main title as H1 and change the other headings to H2 before saving.';
  return null;
}
