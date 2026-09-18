import type { BreadcrumbItem } from './page-breadcrumbs.js';
import type { Page, SiteSettings } from './types.js';

/** Indexing and following are independent; private/version surfaces override both. */
export function pageRobots(page: Pick<Page, 'noindex' | 'nofollow'>, settings: Pick<SiteSettings, 'sitewide_noindex' | 'sitewide_nofollow'>, blocked = false): string {
  if (blocked) return 'noindex,nofollow';
  return `${page.noindex || settings.sitewide_noindex ? 'noindex' : 'index'},${page.nofollow || settings.sitewide_nofollow ? 'nofollow' : 'follow'}`;
}

export function breadcrumbJsonLd({ pathname, canonical, baseUrl, title, siteName, breadcrumbs }: {
  pathname: string; canonical: string; baseUrl: string; title: string; siteName: string; breadcrumbs: BreadcrumbItem[];
}): string | null {
  if (pathname === '/') return null;
  const parents = breadcrumbs.filter(crumb => !crumb.current && crumb.href !== '/');
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: siteName, item: new URL('/', baseUrl).href },
    ...parents.map((crumb, index) => ({ '@type': 'ListItem', position: index + 2, name: crumb.label, item: new URL(crumb.href, baseUrl).href })),
    { '@type': 'ListItem', position: parents.length + 2, name: title, item: canonical },
  ] });
}

/** Only direct Schema.org properties are supported by content-type field maps. */
export function schemaFieldMapError(map: unknown): string | null {
  if (map == null) return null;
  if (typeof map !== 'object' || Array.isArray(map)) return 'schema_field_map must be an object';
  for (const [field, property] of Object.entries(map)) {
    if (typeof property !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(property) || ['__proto__', 'constructor', 'prototype'].includes(property)) {
      return `schema_field_map.${field}: use a direct Schema.org property; nested paths and reserved properties are not supported`;
    }
  }
  return null;
}

export function seoReviewError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'seo_review must be an object';
  const review = value as Record<string, unknown>;
  if (Object.keys(review).some(key => !['forbidden_markers', 'claims', 'notes'].includes(key))) return 'seo_review contains unsupported fields';
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
  for (const key of ['forbidden_markers', 'notes']) if (review[key] !== undefined && (!Array.isArray(review[key]) || review[key].length > 100 || !review[key].every(text))) return `seo_review.${key} must contain at most 100 nonempty strings (500 characters each)`;
  if (review.claims !== undefined && (!Array.isArray(review.claims) || review.claims.length > 100 || !review.claims.every(rule => rule && typeof rule === 'object' && text(rule.phrase) && text(rule.guidance) && Object.keys(rule).every(key => ['phrase', 'guidance'].includes(key))))) return 'seo_review.claims must contain at most 100 phrase/guidance pairs';
  return null;
}
