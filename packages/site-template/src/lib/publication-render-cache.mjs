import { createHash } from 'node:crypto';

export const RENDER_CACHE_FORMAT = 2;
export const MAX_RENDER_CACHE_BYTES = 32 * 1024 * 1024;
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

// Built-in queries and references record their actual reads at render time.
// Unknown blocks retain the whole Page set dependency until their contract is known.
const localBlocks = new Set([
  'core/section', 'core/columns', 'core/container', 'core/grid', 'core/prose',
  'core/heading', 'core/rich_heading', 'core/image', 'core/button', 'core/spacer',
  'core/divider', 'core/icon', 'core/icon_box', 'core/hero', 'core/cta',
  'core/testimonial', 'core/team_member', 'core/pricing_plan', 'core/post_card',
  'core/logo_item', 'core/step_card', 'core/navigation', 'core/accordion',
  'core/tabs', 'core/video', 'core/media_card', 'core/feature_row', 'core/search',
  'core/table_of_contents', 'core/html', 'core/embed', 'core/table', 'core/list',
  'template/page_title', 'template/page_featured_image', 'template/page_excerpt',
  'template/page_date', 'template/page_author', 'template/page_breadcrumbs',
  'template/site_logo', 'template/site_title', 'template/site_tagline',
  'template/show_if', 'template/page_navigation', 'template_content_slot',
  'core/repeater', 'core/page_list', 'core/field_list',
]);
function broadDependency(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.type === 'string' && !localBlocks.has(value.type)) return true;
  return Object.values(value).some(child => Array.isArray(child) ? child.some(broadDependency) : broadDependency(child));
}

/** Build IDs/times identify an attempt, never the renderer's content dependencies. */
export function createRenderPlan(publication, manifest, runtime = process.version) {
  const pages = publication.pages ?? [];
  // The renderer receives exactly these fixture records. Operational snapshots,
  // source hashes and retained media-transfer manifests are not HTML inputs.
  // Media here is the prepared/retargeted public metadata, not expiring grants.
  const globals = Object.fromEntries(['site_url', 'version_id', 'core_commit', 'site', 'settings',
    'partials', 'media', 'blockTypes', 'pageTemplates', 'contentTypes', 'forms', 'apps', 'extensions']
    .map(key => [key, publication[key]]));
  const renderer = Object.fromEntries(Object.entries(manifest.files).filter(([name]) =>
    name !== 'publication.json' && !name.startsWith('content/')));
  const globalKey = digest({ format: RENDER_CACHE_FORMAT, runtime, renderer, globals,
    platform: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions(), year: new Date().getFullYear() });
  const allPages = digest(pages);
  const sharedBroad = (publication.blockTypes?.length ?? 0) > 0 || broadDependency(publication.partials) || broadDependency(publication.forms);
  const keys = Object.fromEntries(pages.map(page => {
    const type = publication.contentTypes?.find(value => value.id === (page.content_type ?? 'page'));
    const template = publication.pageTemplates?.find(value => value.id === (page.template || type?.template));
    const broad = sharedBroad || broadDependency(page.blocks) || broadDependency(template?.blocks);
    return [page.id, { key: digest({ globalKey, page, dependencies: broad ? allPages : undefined }),
      dependency: broad ? 'page_set' : 'recorded' }];
  }));
  return { format: RENDER_CACHE_FORMAT, globalKey, allPages, keys, facetBroad: sharedBroad || broadDependency(publication.pageTemplates) };
}

export function routeFingerprint(plan, pathname, props) {
  // Facets carry their own Page and scope in props and record listing queries.
  // Never inherit the key of an unrelated real Page with the same generated ID.
  const entry = plan.keys[props.page?.id];
  return digest({ pathname, props, key: props.facet ? (plan.facetBroad ? digest([plan.globalKey, plan.allPages]) : plan.globalKey) : entry?.key ?? digest([plan.globalKey, plan.allPages]) });
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
