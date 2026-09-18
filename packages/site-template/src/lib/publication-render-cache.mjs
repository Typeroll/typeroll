import { createHash } from 'node:crypto';

import { SEO_VALIDATOR_VERSION } from './publication-validation.mjs';
export const RENDER_CACHE_FORMAT = 4;
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
  const globals = Object.fromEntries(['site_url', 'version_id', 'core_commit', 'site', 'settings',
    'partials', 'blockTypes', 'pageTemplates', 'contentTypes', 'forms', 'apps', 'extensions']
    .map(key => [key, publication[key]]));
  const renderer = Object.fromEntries(Object.entries(manifest.files).filter(([name]) =>
    name !== 'publication.json' && !name.startsWith('content/')));
  const globalKey = digest({ format: RENDER_CACHE_FORMAT, validator: SEO_VALIDATOR_VERSION, runtime, renderer, globals,
    platform: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions(), year: new Date().getFullYear() });
  const keys = Object.fromEntries(pages.map(page => [page.id, {
    key: digest({ globalKey, page }), dependency: 'recorded',
  }]));
  return { format: RENDER_CACHE_FORMAT, globalKey, keys };
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
