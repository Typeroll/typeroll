// Text of a site's llms.txt and llms-full.txt (https://llmstxt.org). The
// site template decides which pages are listed; this module only formats.

import { pageMarkdown } from './page-markdown.js';
import type { ContentType, Page, SiteSettings } from './types.js';

export interface AgentPage {
  page: Page;
  type?: ContentType;
  /** Path of the HTML page, following the site's trailing-slash policy. */
  path: string;
  /** Path of the Markdown rendition: the page path's folder plus index.md. */
  markdownPath: string;
  /** Language section tag, or undefined for the site language. */
  section?: string;
}

/** `/` → `/index.md`, `/about/` and `/about` → `/about/index.md`. */
export function markdownPathFor(path: string): string {
  const folder = path.endsWith('/') ? path : `${path}/`;
  return `${folder}index.md`;
}

/** About 1 MB: large enough for most sites, small enough for one agent read. */
export const LLMS_FULL_MAX_BYTES = 1_000_000;

const encoder = new TextEncoder();
function byteLength(text: string): number { return encoder.encode(text).length; }

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function linkText(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

export interface LlmsGroup { heading: string; pages: AgentPage[] }

/**
 * Site-language groups first (the default Page type, then other types by
 * label), then each language section in its configured order.
 */
export function llmsGroups(settings: Pick<SiteSettings, 'language_sections'>, pages: AgentPage[]): LlmsGroup[] {
  const sectionOrder = (settings.language_sections ?? []).map(section => section.language);
  const keys = new Map<string, LlmsGroup & { section: number; isDefault: boolean; label: string }>();
  for (const entry of pages) {
    const section = entry.section ? sectionOrder.indexOf(entry.section) + 1 : 0;
    const typeId = entry.type?.id ?? 'page';
    const label = oneLine(entry.type?.label_plural) || 'Pages';
    const key = `${section}\u0000${typeId}`;
    let group = keys.get(key);
    if (!group) {
      group = { heading: entry.section ? `${label} (${entry.section})` : label, pages: [], section, isDefault: typeId === 'page', label };
      keys.set(key, group);
    }
    group.pages.push(entry);
  }
  return [...keys.values()]
    .sort((a, b) => a.section - b.section || Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
    .map(({ heading, pages }) => ({ heading, pages }));
}

function header(settings: SiteSettings, intro: string): string[] {
  const lines = [`# ${oneLine(settings.site_name) || 'Website'}`];
  const summary = oneLine(settings.tagline || settings.default_meta_description);
  if (summary) lines.push('', `> ${summary}`);
  lines.push('', intro);
  return lines;
}

export function llmsIndex(settings: SiteSettings, pages: AgentPage[], base: string): string {
  const lines = header(settings, [
    'Each page below links to its web address. A Markdown version of every page is at the same address followed by `index.md`.',
    '',
    `- [Sitemap](${base}/sitemap.xml)`,
    `- [All pages as Markdown](${base}/llms-full.txt)`,
  ].join('\n'));
  for (const group of llmsGroups(settings, pages)) {
    lines.push('', `## ${group.heading}`, '');
    for (const entry of group.pages) {
      const description = oneLine(entry.page.seo_description);
      lines.push(`- [${linkText(oneLine(entry.page.title) || entry.path)}](${base}${entry.path})${description ? `: ${description}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function llmsFull(settings: SiteSettings, pages: AgentPage[], base: string, maxBytes = LLMS_FULL_MAX_BYTES): string {
  const parts = [header(settings, `The full text of every page listed in ${base}/llms.txt, as Markdown.`).join('\n')];
  let size = byteLength(parts[0]!);
  const remaining: AgentPage[] = [];
  for (const group of llmsGroups(settings, pages)) {
    for (const entry of group.pages) {
      if (remaining.length) { remaining.push(entry); continue; }
      const text = `\n\n---\n\n${pageMarkdown(entry.page, { url: `${base}${entry.path}`, contentType: entry.type }).trim()}`;
      const bytes = byteLength(text);
      if (size + bytes > maxBytes) { remaining.push(entry); continue; }
      parts.push(text);
      size += bytes;
    }
  }
  if (remaining.length) {
    parts.push(`\n\n---\n\n## More pages\n\nThis file reached its size limit. The remaining pages are available as separate Markdown files:\n\n${remaining
      .map(entry => `- [${linkText(oneLine(entry.page.title) || entry.path)}](${base}${entry.markdownPath})`).join('\n')}`);
  }
  return `${parts.join('').trim()}\n`;
}
