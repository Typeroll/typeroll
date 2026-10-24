import { customCssWriteError } from './custom-css-write';
import { paths, slugify, escapeHtml, pageAuthorityFields, ensureBlockIds, contentPagePath, DEFAULT_CONTENT_TYPE, type ContentType, type Page, type Media } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore } from './version-store';
import { pageContentType, validatePageFields, validatePagePresentation } from './page-fields';
import { applyFieldAuthority, conflictResponse, type WriteActor } from './field-authority';
import { WorkingCopyError, listWorkingCopies, overlayWorkingCopy, type WcCtx } from './working-copy';
import { validatePathField, makeSafePageId } from './page-paths';
import { blockTreeInputError } from './block-tree-input';
import { checkAlternates } from './page-alternates';
import { sanitizeBody } from './sanitize';
import { buildMediaLookup, transformBodyForSeo } from './seo-transform';
import { isLivePageStatus, retireRedirectsShadowingUrl } from './redirect-hygiene';
import { markSiteDirty } from './auto-deploy';

const CREATE_FIELDS = ['path', 'parent', 'sort_order', 'template', 'kind', 'author', 'language',
  'breadcrumb_label', 'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'append_seo_suffix',
  'noindex', 'nofollow', 'alternates', 'lastmod_override', 'json_ld', 'schema_type', 'service', 'image_sizes_default',
  'custom_css', 'date_published', 'publish_at', 'unpublish_at'] as const;

/** Returned when a title-derived slug had to change because its address was taken. */
export interface SlugAdjustedWarning {
  code: 'slug_adjusted';
  message: string;
  /** The slug derived from the title. */
  requested: string;
  /** The slug the page was created with. */
  slug: string;
  /** The new page's address, or null for a content type without routes. */
  path: string | null;
  /** The page that already held the requested address. */
  conflicting_page_id: string;
}

export interface CreatePageResult {
  page: Page;
  retired_redirects: Array<{ from_path: string; to_path: string }>;
  warnings?: SlugAdjustedWarning[];
}

/**
 * Every address a new page could collide with: each page's saved address and,
 * when its unsaved draft (working copy) changes slug, path or fields, the
 * address that draft will claim on save. Drafts and unlisted pages count.
 */
async function occupiedAddresses(ctx: WcCtx, pages: Page[], types: Map<string, ContentType>): Promise<Map<string, Page>> {
  const owners = new Map<string, Page>();
  const claim = (page: Page) => {
    const definition = types.get(page.content_type ?? 'page');
    const url = definition ? contentPagePath(page, definition) : null;
    if (url !== null && !owners.has(url)) owners.set(url, page);
  };
  for (const page of pages) claim(page);
  const byId = new Map(pages.map(page => [page.id, page]));
  for (const draft of await listWorkingCopies(ctx)) {
    const page = draft.kind === 'page' ? byId.get(draft.target_id) : undefined;
    if (page && draft.fields && ['slug', 'path', 'fields'].some(key => key in draft.fields)) claim(overlayWorkingCopy(page, draft));
  }
  return owners;
}

function addressInUse(owner: Page, url: string | null, requested: { slug: string; path?: string; slugRoutes: boolean }): WorkingCopyError {
  const details = { page_id: owner.id, path: url };
  const code = requested.path || !requested.slugRoutes ? 'path_in_use' : 'slug_in_use';
  if (url === '/') return new WorkingCopyError('A homepage already exists. Edit the existing page.', 409, code, details);
  if (requested.path) return new WorkingCopyError(`A page already uses ${requested.path} (page ${owner.id}). Choose another path, or edit the existing page.`, 409, code, details);
  if (!requested.slugRoutes) return new WorkingCopyError(`A page already uses ${url} (page ${owner.id}). This content type builds the address from fields other than the slug; change those fields, set path, or edit the existing page.`, 409, code, details);
  const where = url === null ? `another ${owner.content_type ?? 'page'} record` : url;
  return new WorkingCopyError(`Slug "${requested.slug}" is already in use: ${where} belongs to page ${owner.id}. Choose another slug, or edit the existing page.`, 409, 'slug_in_use', details);
}

/**
 * All surfaces create the same Page. Content types only supply schema and defaults.
 *
 * Address rule: an explicit `slug` or `path` that is already in use answers 409
 * (`slug_in_use` / `path_in_use`, details `{ page_id, path }`) — the requested
 * address is never silently changed. Only a slug derived from the title gets a
 * numeric suffix, and the result then carries a `slug_adjusted` warning.
 */
export async function createPage(ctx: WcCtx, input: Partial<Page>, actor: WriteActor, actorId: string): Promise<CreatePageResult> {
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
  const authority = applyFieldAuthority({ fields: pageAuthorityFields(type), incoming: { ...input, ...fields }, existing: undefined, actor, actorId });
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
  const cssError = customCssWriteError(page.custom_css);
  if (cssError) throw new WorkingCopyError(cssError, 400);
  const presentationError = await validatePagePresentation(ctx, type, page);
  if (presentationError) throw new WorkingCopyError(presentationError, 400);
  const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  const types = new Map((await vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId)).map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const owners = await occupiedAddresses(ctx, pages, types);
  const usedIds = new Set(pages.map(existing => existing.id));
  const explicitSlug = input.slug !== undefined;
  const baseSlug = page.slug;
  let conflict: Page | undefined;
  let suffix = 2;
  while (true) {
    const url = contentPagePath(page, type);
    // Routeless content types have no address; their slug is unique per type.
    const owner = url !== null ? owners.get(url) : pages.find(existing => (existing.content_type ?? 'page') === type.id && existing.slug === page.slug);
    if (!owner) break;
    // A route built from other fields (or an explicit path) does not change with the slug.
    const slugRoutes = url === null || contentPagePath({ ...page, slug: `${page.slug}-x` }, type) !== url;
    if (url === '/' || page.path || !slugRoutes || explicitSlug) throw addressInUse(owner, url, { slug: page.slug, path: page.path, slugRoutes });
    conflict ??= owner;
    page.slug = `${baseSlug}-${suffix++}`;
    if (suffix > owners.size + pages.length + 3) throw new WorkingCopyError('URL pattern does not produce a unique page address', 409);
  }
  const url = contentPagePath(page, type);
  // The id is internal: when an unrelated page already holds the id derived
  // from this address (e.g. it moved to another path), number the id, never the slug.
  const baseId = makeSafePageId(url ?? `${type.id}-${page.slug}`);
  page.id = baseId;
  for (let n = 2; usedIds.has(page.id); n++) page.id = `${baseId.slice(0, 94)}-${n}`;
  const warnings: SlugAdjustedWarning[] = conflict ? [{
    code: 'slug_adjusted',
    message: `The slug "${baseSlug}" derived from the title is already in use by page ${conflict.id}, so the page was created as "${page.slug}"${url ? ` at ${url}` : ''}. Pass an explicit slug to be told about a conflict instead.`,
    requested: baseSlug, slug: page.slug, path: url, conflicting_page_id: conflict.id,
  }] : [];
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
  const retired = url && isLivePageStatus(page.status) ? await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, url) : [];
  await markSiteDirty(ctx.orgId, ctx.siteId, ctx.versionId);
  return { page, retired_redirects: retired.map(redirect => ({ from_path: redirect.from_path, to_path: redirect.to_path })), ...(warnings.length ? { warnings } : {}) };
}
