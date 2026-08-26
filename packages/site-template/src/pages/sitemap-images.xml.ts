// Image sitemap — sitemaps.org extension that lets search engines discover
// every image referenced by the site. Useful for image search ranking and
// for sites where images live on a different origin (our CDN).
//
// We extract `<img src>` and `<img srcset>` entries from each published
// page's body. og:image doesn't need to be here — it's already a per-page
// meta tag.

import type { APIRoute } from 'astro';
import { getAllPages, urlFor } from '../lib/content';
import type { Page } from '@typeroll/shared';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const pages = await getAllPages({ includeUnlisted: false });

  const entries = pages
    .filter((p) => !p.noindex)
    .map((p) => {
      const images = extractImages(p);
      if (images.length === 0) return '';
      const loc = `${base}${urlFor(p)}`;
      const imageTags = images
        .map((img) => `<image:image><image:loc>${escapeXml(img)}</image:loc></image:image>`)
        .join('');
      return `<url><loc>${escapeXml(loc)}</loc>${imageTags}</url>`;
    })
    .filter(Boolean)
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entries}</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};

function extractImages(page: Page): string[] {
  const set = new Set<string>();
  const html = page.html_content ?? '';
  if (page.og_image) set.add(page.og_image);
  for (const m of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    set.add(m[1]);
  }
  // srcset: "url1 1x, url2 2x" — grab every URL.
  for (const m of html.matchAll(/<img\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi)) {
    for (const part of m[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) set.add(url);
    }
  }
  // Filter out data: URIs.
  return Array.from(set).filter((u) => !/^data:/i.test(u));
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
