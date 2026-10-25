import { createHash } from 'node:crypto';

import { SEO_VALIDATOR_VERSION } from './publication-validation.mjs';
export const RENDER_CACHE_FORMAT = 7;
export const MAX_RENDER_CACHE_BYTES = 32 * 1024 * 1024;
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

// Custom blocks are declarative templates, aliases and containers, not
// server-side plug-ins. They use the same tracked queries and context as core
// blocks. Merely installing a block type must not depend on every Page.
/** Build IDs/times identify an attempt, never the renderer's content dependencies. */
export function createRenderPlan(publication, manifest, runtime = process.version) {
  const pages = publication.pages ?? [];
  // The renderer receives exactly these fixture records. Operational snapshots,
  // source hashes and retained media-transfer manifests are not HTML inputs.
  // Prepared media metadata is tracked per URL when the renderer reads it.
  const globals = Object.fromEntries(['site_url', 'version_id', 'core_commit', 'robots_blocked', 'site', 'settings',
    'partials', 'blockTypes', 'pageTemplates', 'contentTypes', 'forms', 'apps', 'extensions']
    .map(key => [key, publication[key]]));
  const renderer = Object.fromEntries(Object.entries(manifest.files).filter(([name]) =>
    name !== 'publication.json' && !name.startsWith('content/')));
  const globalKey = digest({ format: RENDER_CACHE_FORMAT, validator: SEO_VALIDATOR_VERSION, runtime, renderer, globals,
    platform: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions(), year: new Date().getFullYear() });
  const keys = Object.fromEntries(pages.map(page => [page.id, {
    key: digest({ globalKey, page }), dependency: 'recorded',
  }]));
  const origins = [new URL(publication.site_url).origin];
  if (publication.media_manifest?.media_host) {
    const mediaOrigin = `https://${publication.media_manifest.media_host}`;
    if (!origins.includes(mediaOrigin)) origins.push(mediaOrigin);
  }
  const proof = { globals, pages, media: publication.media ?? [], derived: publication.derived ?? {} };
  // The proof covers ALL render inputs, not just the current Page. Rebase is
  // allowed only for an origin substitution with no content or policy change.
  const normalized = normalizeOrigins(proof, origins);
  // Derived data has a content-addressed URL embedded in HTML; a changed
  // payload needs fresh rendering even when its only changed values are URLs.
  normalized.derived = publication.derived ?? {};
  if (normalized.globals.site?.domain === new URL(publication.site_url).hostname) normalized.globals.site.domain = 'typeroll-website.invalid';
  const domainKey = digest({ normalized, renderer, runtime, format: RENDER_CACHE_FORMAT, validator: SEO_VALIDATOR_VERSION,
    platform: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions(), year: new Date().getFullYear() });
  return { format: RENDER_CACHE_FORMAT, globalKey, keys, origins, domainKey };
}

export function routeFingerprint(plan, pathname, props) {
  // Facets carry their own Page and scope in props and record listing queries.
  // Never inherit the key of an unrelated real Page with the same generated ID.
  const entry = plan.keys[props.page?.id];
  return digest({ pathname, props, key: props.facet ? plan.globalKey : entry?.key ?? plan.globalKey });
}

export function validCacheEntry(entry, fingerprint) {
  return entry && entry.fingerprint === fingerprint && typeof entry.html === 'string'
    && Array.isArray(entry.dependencies) && entry.dependencyHash === digest(entry.dependencies)
    && Buffer.byteLength(entry.html) <= 4 * 1024 * 1024 && digest(entry.html) === entry.sha256;
}

export function readRenderCache(bytes) {
  try {
    if (bytes.length > MAX_RENDER_CACHE_BYTES) return null;
    const cache = JSON.parse(bytes.toString());
    if (cache.format !== RENDER_CACHE_FORMAT || !cache.routes || Array.isArray(cache.routes)
      || typeof cache.routes !== 'object' || Object.keys(cache.routes).length > 20000) return null;
    return cache;
  } catch { return null; }
}

const originEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function replaceRenderOrigins(value, from, to) {
  const pairs = from.map((origin, index) => [origin, to[index]]).sort((a, b) => b[0].length - a[0].length);
  const targets = new Map(pairs);
  const pattern = new RegExp(`(?:${pairs.map(([origin]) => originEscape(origin)).join('|')})(?=[/?#\\s"'<>),\\]\\\\]|$)`, 'g');
  const visit = item => typeof item === 'string' ? item.replace(pattern, origin => targets.get(origin))
    : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)])) : item;
  return visit(value);
}
export function normalizeOrigins(value, origins) { return replaceRenderOrigins(value, origins, origins.map((_, index) => `https://typeroll-origin-${index}.invalid`)); }
export function domainRouteFingerprint(plan, pathname, props) { return digest({ pathname, props: normalizeOrigins(props, plan.origins), key: plan.domainKey }); }
export function canRebaseCache(previous, plan) { return previous?.domainKey === plan.domainKey && Array.isArray(previous.origins) && previous.origins.length === plan.origins.length && previous.origins.some((origin, index) => origin !== plan.origins[index]); }
