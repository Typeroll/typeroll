import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../lib/revisions';
import { getStore } from '../../../../../lib/datastore';
import { buildMediaLookup, transformBodyForSeo, lintBodyForSeo } from '../../../../../lib/seo-transform';
import { pageUrlFromDoc } from '../../../../../lib/page-paths';
import {
  isLivePageStatus,
  removeAutoRedirectsTargeting,
  retireRedirectsShadowingUrl,
} from '../../../../../lib/redirect-hygiene';
import { paths } from '@typeroll/shared';
import type { Media, Page } from '@typeroll/shared';

// Whitelist of fields that the editor can update. Everything else is silently
// ignored so a compromised client can't write arbitrary fields (status flags,
// timestamps from before, etc.).
const ALLOWED_FIELDS: Array<keyof Page> = [
  'title',
  'slug',
  'parent',
  'sort_order',
  'template',
  'content_mode',
  'blocks',
  'html_content',
  'seo_title',
  'append_seo_suffix',
  'seo_description',
  'og_image',
  'seo_image_alt',
  'canonical_url',
  'noindex',
  'lastmod_override',
  'json_ld',
  'schema_type',
  'service',
  'kind',
  'author',
  'image_sizes_default',
  'custom_css',
  'status',
  'date_published',
  'date_updated',
  'publish_at',
  'unpublish_at',
];

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const body = (await request.json()) as Partial<Page>;
  const update: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in body) update[key] = body[key];
  }
  update.date_updated = new Date().toISOString();

  // Chain-read the existing doc (branch override OR base fallback). On a
  // branch this is the "fork on first write" — we materialise a full
  // override at the branch path so the chain reader stops finding the base
  // copy. Read it up front so the SEO transform can resolve the page-level
  // `image_sizes_default` even when this PUT only touches the body.
  const existing = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!existing) return json({ error: 'Page not found' }, 404);

  // SEO/Core Web Vitals transform: defaults loading="lazy"+decoding="async"
  // on non-leading <img>, injects width/height/alt from the Media collection,
  // and wraps Cloudflare-hosted images in <picture> with srcset variants
  // when CF_IMAGE_ORIGIN is set. Idempotent.
  let warnings: string[] = [];
  if (typeof update.html_content === 'string' && update.html_content) {
    const media = await getStore().listDocs<Media>(paths.media(owner_org_id, site.id));
    const lookup = buildMediaLookup(media);
    // Responsive-image `sizes` default: page-level (incoming PUT or stored)
    // overrides the site-wide setting; a per-<img> `sizes` still wins inside
    // the transform.
    const settings = await vstore.settings(owner_org_id, site.id, versionId);
    const defaultSizes =
      (update.image_sizes_default as string | undefined) ||
      existing.image_sizes_default ||
      settings?.image_sizes_default ||
      undefined;
    const transformed = transformBodyForSeo(update.html_content, lookup, {
      cfImageOrigin: process.env.CF_IMAGE_ORIGIN || undefined,
      defaultSizes,
    });
    update.html_content = transformed;
    warnings = lintBodyForSeo(transformed);
  }
  await snapshotRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
    doc: existing as unknown as Record<string, unknown>,
    createdBy: session.email ?? 'unknown',
  });
  await vstore.writePage(owner_org_id, site.id, versionId, pageId, update as Partial<Page>);

  // Slug/status changes can put a live page on a URL an existing redirect
  // still claims — retire that redirect, or the next deploy's `_redirects`
  // shadows the page on Cloudflare Pages (redirects win over static files).
  if ('slug' in update || 'status' in update) {
    const fresh = await vstore.page(owner_org_id, site.id, versionId, pageId);
    if (fresh && isLivePageStatus(fresh.status)) {
      await retireRedirectsShadowingUrl(owner_org_id, site.id, versionId, pageUrlFromDoc(fresh));
    }
  }
  return json({ ok: true, seo_warnings: warnings });
};

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const page = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!page) return json({ error: 'Not found' }, 404);
  return json(page);
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const existing = await vstore.page(owner_org_id, site.id, versionId, pageId);
  await vstore.deletePage(owner_org_id, site.id, versionId, pageId);
  // Auto-generated redirects pointing at the deleted page's URL would 301
  // visitors into a 404 — drop them. Manual redirects are kept on purpose.
  if (existing) {
    await removeAutoRedirectsTargeting(owner_org_id, site.id, versionId, pageUrlFromDoc(existing));
  }
  return json({ ok: true });
};
