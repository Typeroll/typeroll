// Placeholders left in content: bracketed text such as "[Feature name]" that
// the built-in starters and many templates use to mark what to replace
// (shared/src/site-handover.ts → bracketPlaceholders). Reported as a site
// readiness item and as a publication warning; nothing blocks.

import { bracketPlaceholders } from '@typeroll/shared';

interface PageLike { id: string; title?: unknown; path?: unknown; slug?: unknown; status?: unknown; blocks?: unknown; html_content?: unknown; fields?: unknown }
interface PartialLike { id: string; name?: unknown; kind?: unknown; status?: unknown; blocks?: unknown; html_content?: unknown }

export interface PlaceholderFinding {
  kind: 'page' | 'global_block';
  id: string;
  label: string;
  /** The page's address, when it has one. */
  path?: string;
  /** Up to `examples` placeholders, e.g. "[Feature name]". */
  examples: string[];
}

const LIVE = new Set(['published', 'unlisted']);
const isLive = (status: unknown) => status === undefined || LIVE.has(String(status));

/** Live pages and published global blocks (header and footer included) whose content still has placeholders. */
export function placeholderFindings(content: { pages?: readonly PageLike[]; partials?: readonly PartialLike[] }, examples = 3): PlaceholderFinding[] {
  const found: PlaceholderFinding[] = [];
  for (const page of content.pages ?? []) {
    if (!isLive(page.status)) continue;
    const list = bracketPlaceholders({ blocks: page.blocks, html: page.html_content, fields: page.fields }, examples);
    if (!list.length) continue;
    const path = typeof page.path === 'string' && page.path ? page.path : typeof page.slug === 'string' ? `/${page.slug}` : undefined;
    found.push({ kind: 'page', id: page.id, label: String(page.title || page.id), ...(path ? { path } : {}), examples: list });
  }
  for (const partial of content.partials ?? []) {
    if (!isLive(partial.status)) continue;
    const list = bracketPlaceholders({ blocks: partial.blocks, html: partial.html_content }, examples);
    if (!list.length) continue;
    found.push({ kind: 'global_block', id: partial.id, label: String(partial.name || partial.id), examples: list });
  }
  return found;
}

/** Where a finding is edited in the portal. */
export function placeholderEditorHref(siteId: string, finding: Pick<PlaceholderFinding, 'kind' | 'id'>): string {
  return finding.kind === 'page'
    ? `/app/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(finding.id)}`
    : `/app/sites/${encodeURIComponent(siteId)}/partials/${encodeURIComponent(finding.id)}`;
}

export function placeholderLine(finding: PlaceholderFinding): string {
  const where = finding.kind === 'page' ? `${finding.label}${finding.path ? ` (${finding.path})` : ''}` : `Global block ${finding.label}`;
  return `${where}: ${finding.examples.join(', ')}`;
}

/** Non-blocking publication finding for placeholder text the frozen content still shows. */
export function publicationPlaceholderWarnings(publication: { pages?: readonly PageLike[]; partials?: readonly PartialLike[] }): string[] {
  const found = placeholderFindings(publication);
  if (!found.length) return [];
  const pages = found.filter(entry => entry.kind === 'page').length;
  const globals = found.length - pages;
  const counted = [pages ? `${pages} page${pages === 1 ? '' : 's'}` : '', globals ? `${globals} global block${globals === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const shown = found.slice(0, 5).map(placeholderLine).join('; ');
  return [`Placeholder text such as "${found[0].examples[0]}" is still on ${counted} and will be published (${shown}${found.length > 5 ? '; …' : ''}). Replace it with the real text.`];
}
