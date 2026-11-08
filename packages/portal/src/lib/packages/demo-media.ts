// Demo media: files a template package marked as sample content. The site
// lists them for replacement before a publication shows them; nothing blocks.

import type { Media } from '@typeroll/shared';
import { findReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';

/** Every address content may use for a media file: its address, earlier and published ones, and its variants. */
export function mediaAddresses(media: Media): string[] {
  return [...new Set([media.cdn_url, media.published_url ?? '', ...(media.source_aliases ?? []), ...(media.variants ?? []).map(variant => variant.cdn_url)]
    .filter((url): url is string => typeof url === 'string' && url.length > 0))];
}

/** The demo files that the given content references. */
export function demoMediaReferenced(media: readonly Media[], content: unknown): Media[] {
  const demo = media.filter(item => item.demo === true);
  if (!demo.length) return [];
  const found = findReferences(typeof content === 'string' ? content : JSON.stringify(content ?? null), demo.flatMap(mediaAddresses));
  return demo.filter(item => mediaAddresses(item).some(address => found.has(address)));
}

/** Non-blocking publication finding for demo files the frozen content shows. */
export function publicationDemoMediaWarnings(sourceMedia: readonly Media[]): string[] {
  const demo = sourceMedia.filter(item => item.demo === true);
  if (!demo.length) return [];
  const names = demo.slice(0, 10).map(item => item.filename || item.id).join(', ');
  return [`${demo.length} demo image${demo.length === 1 ? '' : 's'} from a template package ${demo.length === 1 ? 'is' : 'are'} published (${names}${demo.length > 10 ? ', …' : ''}). Replace ${demo.length === 1 ? 'it' : 'them'} with your own, or keep ${demo.length === 1 ? 'it' : 'them'} in the Media library.`];
}
