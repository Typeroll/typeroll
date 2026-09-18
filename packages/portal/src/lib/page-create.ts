import { paths, slugify, escapeHtml, pageAuthorityFields, ensureBlockIds, contentPagePath, DEFAULT_CONTENT_TYPE, type Page, type Media } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore } from './version-store';
import { pageContentType, validatePageFields, validatePagePresentation } from './page-fields';
import { applyFieldAuthority, conflictResponse, type WriteActor } from './field-authority';
import { WorkingCopyError, type WcCtx } from './working-copy';
import { validatePathField, makeSafePageId } from './page-paths';
import { blockTreeInputError } from './block-tree-input';
import { checkAlternates } from './page-alternates';
import { sanitizeBody } from './sanitize';
import { buildMediaLookup, transformBodyForSeo } from './seo-transform';
import { isLivePageStatus, retireRedirectsShadowingUrl } from './redirect-hygiene';
import { markSiteDirty } from './auto-deploy';

const CREATE_FIELDS = ['path', 'parent', 'sort_order', 'template', 'kind', 'author', 'language',
  'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'append_seo_suffix',
  'noindex', 'nofollow', 'alternates', 'lastmod_override', 'json_ld', 'schema_type', 'service', 'image_sizes_default',
  'custom_css', 'date_published', 'publish_at', 'unpublish_at'] as const;

/** All surfaces create the same Page. Content types only supply schema and defaults. */
export async function createPage(ctx: WcCtx, input: Partial<Page>, actor: WriteActor, actorId: string): Promise<{ page: Page; retired_redirects: Array<{ from_path: string; to_path: string }> }> {
  const title = String(input.title ?? '').trim();
  if (!title) throw new WorkingCopyError('title required', 400);
  const type = await pageContentType(ctx, input);
  if (!type) throw new WorkingCopyError('Content type not found', 400);
  if (input.fields !== undefined) {
    const error = validatePageFields(type, input.fields);
    if (error) throw new WorkingCopyError(error, 400);
  }
  const fields = { ...Object.fromEntries(type.fields.filter(field => field.default !== undefined).map(field => [field.name, field.default])), ...input.fields };
  const fieldError = validatePageFields(type, fields);
  if (fieldError) throw new WorkingCopyError(fieldError, 400);
  const authority = applyFieldAuthority({ fields: pageAuthorityFields(type), incoming: { ...input, ...input.fields }, existing: undefined, actor, actorId });
  if (authority.rejected.length) throw new WorkingCopyError(conflictResponse(authority.rejected).error, 409);
  const treeError = blockTreeInputError(input.blocks);
  if (treeError) throw new WorkingCopyError(treeError, 400);
  const path = validatePathField(input.path);
  if (!path.ok) throw new WorkingCopyError(`Invalid path: ${path.error}`, 400);
  const alternate = checkAlternates(input);
  if (!alternate.ok) throw new WorkingCopyError(alternate.error, 400);
  const status = input.status ?? 'draft';
  if (!['draft', 'review', 'unlisted', 'published'].includes(status)) throw new WorkingCopyError('Invalid publication status', 400);
  if (input.content_mode !== undefined && !['blocks', 'html'].includes(input.content_mode)) throw new WorkingCopyError('Invalid content mode', 400);
  const mode = input.content_mode ?? (typeof input.html_content === 'string' ? 'html' : 'blocks');
  const slug = input.slug === undefined ? slugify(title) || 'page' : String(input.slug).replace(/^\/+|\/+$/g, '');
  if (slug.includes('/')) throw new WorkingCopyError('Page slugs must be a single path segment without slashes. Use the path field for a nested URL.', 400);
  const page: Page = { id: '', title, slug, content_type: type.id, fields, content_mode: mode, status, date_updated: new Date().toISOString() };
  for (const field of CREATE_FIELDS) if (input[field] !== undefined) (page as unknown as Record<string, unknown>)[field] = input[field];
  if (path.path) page.path = path.path;
  else delete page.path;
  if (alternate.present) page.alternates = alternate.value ?? [];
  const presentationError = await validatePagePresentation(ctx, type, page);
  if (presentationError) throw new WorkingCopyError(presentationError, 400);
  const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  const types = new Map((await vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId)).map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const usedPaths = new Set(pages.flatMap(existing => {
    const definition = types.get(existing.content_type ?? 'page');
    const url = definition ? contentPagePath(existing, definition) : null;
    return url ? [url] : [];
  }));
  const baseSlug = page.slug;
  let suffix = 2;
  while (true) {
    const url = contentPagePath(page, type);
    page.id = makeSafePageId(url ?? `${type.id}-${page.slug}`);
    const collision = pages.some(existing => existing.id === page.id) || (url !== null && usedPaths.has(url));
    if (!collision) break;
    if (url === '/') throw new WorkingCopyError('A homepage already exists. Edit the existing page.', 409);
    if (page.path) throw new WorkingCopyError(`A page already uses ${page.path}`, 409);
    page.slug = `${baseSlug}-${suffix++}`;
    if (suffix > pages.length + 3) throw new WorkingCopyError('URL pattern does not produce a unique page address', 409);
  }
  if (mode === 'blocks') {
    page.blocks = ensureBlockIds(input.blocks ?? [
      ...((page.template || type.template) ? [] : [{ id: 'title', type: 'core/heading', data: { text: title, level: 'h1' } }]),
      { id: 'body', type: 'core/prose', data: { html: '<p>Start writing…</p>' } },
    ]);
  } else {
    const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
    const clean = sanitizeBody(input.html_content ?? `<h1>${escapeHtml(title)}</h1><p>Start writing…</p>`, settings?.iframe_allowed_hosts);
    const media = await getStore().listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
    page.html_content = transformBodyForSeo(clean, buildMediaLookup(media), { cfImageOrigin: process.env.CF_IMAGE_ORIGIN || undefined, defaultSizes: page.image_sizes_default || settings?.image_sizes_default });
  }
  const headingError = await validatePagePresentation(ctx, type, page);
  if (headingError) throw new WorkingCopyError(headingError, 400);
  const created = await getStore().createDocIfMissing(paths.page(ctx.orgId, ctx.siteId, page.id, ctx.versionId), { ...page, _provenance: authority.provenance });
  if (!created) throw new WorkingCopyError('A page with this address was just created. Reload and try again.', 409);
  const url = contentPagePath(page, type);
  const retired = url && isLivePageStatus(page.status) ? await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, url) : [];
  await markSiteDirty(ctx.orgId, ctx.siteId);
  return { page, retired_redirects: retired.map(redirect => ({ from_path: redirect.from_path, to_path: redirect.to_path })) };
}
