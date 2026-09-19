import { countBlockH1s, ensureBlockIds, getPageTemplateStarter, templateMatchesContentType, type PageTemplate, type PageTemplateStarterKind } from '@typeroll/shared';
import { vstore } from './version-store';
import { blockTreeInputError } from './block-tree-input';
import { markSiteDirty } from './auto-deploy';
import { ContentTypeError, type ContentTypeContext } from './content-type-service';

export async function savePageTemplate(ctx: ContentTypeContext, id: string, input: Record<string, unknown>, create = false): Promise<PageTemplate> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new ContentTypeError('Template ID must use lowercase letters, digits, underscores or hyphens');
  const existing = await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id);
  if (create && existing) throw new ContentTypeError('Template already exists', 409);
  if (!create && !existing) throw new ContentTypeError('Template not found', 404);
  const patch = Object.fromEntries(['label', 'icon', 'applies_to', 'blocks', 'status'].filter(field => field in input).map(field => [field, input[field]]));
  const next = { ...existing, ...patch, id, name: id, created_at: existing?.created_at ?? new Date().toISOString(), date_updated: new Date().toISOString() } as PageTemplate;
  if (input.starter !== undefined) {
    if (!create || input.blocks !== undefined) throw new ContentTypeError('Choose starter or blocks when creating a template');
    const blocks = getPageTemplateStarter(input.starter as PageTemplateStarterKind);
    if (!blocks) throw new ContentTypeError('Unknown template starter');
    next.blocks = blocks;
  }
  next.label ??= id; next.status ??= 'draft'; next.applies_to ??= 'any'; next.blocks ??= [];
  if (typeof next.label !== 'string' || !next.label.trim()) throw new ContentTypeError('Template label is required');
  if (!['draft', 'published'].includes(next.status)) throw new ContentTypeError('Template status must be draft or published');
  if (!['any', 'page'].includes(next.applies_to) && !/^content_type:[a-z][a-z0-9_-]{0,62}$/.test(next.applies_to)) throw new ContentTypeError('Invalid template content type restriction');
  if (!Array.isArray(next.blocks)) throw new ContentTypeError('Template blocks must be an array');
  const error = blockTreeInputError(next.blocks);
  if (error) throw new ContentTypeError(error);
  if (countBlockH1s(next.blocks) > 1) throw new ContentTypeError('A Page template should provide only one H1. Change additional headings to H2.');
  next.blocks = ensureBlockIds(next.blocks);
  if (existing && next.applies_to !== existing.applies_to) {
    const [pages, types] = await Promise.all([vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId), vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId)]);
    const usedTypes = new Set([...pages.filter(page => page.template === id).map(page => page.content_type ?? 'page'), ...types.filter(type => type.template === id || type.allowed_templates?.includes(id)).map(type => type.id)]);
    if ([...usedTypes].some(type => !templateMatchesContentType(next, type))) throw new ContentTypeError('This template is still used by another content type. Reassign it first.', 409);
  }
  await vstore.writePageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id, next);
  await markSiteDirty(ctx.orgId, ctx.siteId, ctx.versionId);
  return next;
}

export async function removePageTemplate(ctx: ContentTypeContext, id: string): Promise<void> {
  const [pages, types] = await Promise.all([vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId), vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId)]);
  if (pages.some(page => page.template === id) || types.some(type => type.template === id || type.allowed_templates?.includes(id))) throw new ContentTypeError('Choose another template for the pages and content types using this template first', 409);
  if (!await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id)) throw new ContentTypeError('Template not found', 404);
  await vstore.deletePageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id);
  await markSiteDirty(ctx.orgId, ctx.siteId, ctx.versionId);
}
