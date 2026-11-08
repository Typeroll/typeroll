import { countBlockH1s, ensureBlockIds, getPageTemplateStarter, slugify, templateMatchesContentType, type Block, type PageTemplate, type PageTemplateStarterKind } from '@typeroll/shared';
import { assertStructureChange, StructureLockedError } from './structure-lock';
import { vstore } from './version-store';
import { blockTreeInputError } from './block-tree-input';
import { markSiteDirty } from './auto-deploy';
import { ContentTypeError, type ContentTypeContext } from './content-type-service';

const TEMPLATE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TEMPLATE_ID_RULE = 'Template ID must be 1-64 characters: lowercase letters a-z, digits, underscores or hyphens, starting with a letter or digit (for example "article" or "case-study")';
/** Letters NFKD does not decompose to ASCII; å, ä, ö, é and similar are handled by slugify. */
const TRANSLITERATION: Record<string, string> = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i' };

/** A valid template ID derived from a display name, e.g. "Artikel" → "artikel", "Kök & bad" → "kok-bad". */
export function templateIdFromName(name: string): string {
  const ascii = name.toLowerCase().replace(/[æøœßđðþłı]/g, char => TRANSLITERATION[char] ?? char);
  return slugify(ascii).slice(0, 64).replace(/-+$/, '') || 'template';
}

/**
 * The ID for a new template. An explicit `id`, or a `name` that already is a
 * valid ID, is used exactly (a collision is a 409). Any other name is a display
 * name: the ID is derived from it, suffixed -2, -3… when taken, and the name
 * becomes the label unless one is given.
 */
export async function newPageTemplateId(ctx: ContentTypeContext, input: Record<string, unknown>): Promise<{ id: string; input: Record<string, unknown> }> {
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !TEMPLATE_ID.test(input.id)) throw new ContentTypeError(`${TEMPLATE_ID_RULE}. Omit id to derive one from name.`);
    return { id: input.id, input: { ...input, label: input.label ?? (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined) } };
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ContentTypeError('Template name is required');
  if (TEMPLATE_ID.test(name)) return { id: name, input };
  const taken = new Set((await vstore.pageTemplates(ctx.orgId, ctx.siteId, ctx.versionId)).map(template => template.id));
  const base = templateIdFromName(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
  return { id, input: { ...input, label: input.label ?? name } };
}

export async function savePageTemplate(ctx: ContentTypeContext, id: string, input: Record<string, unknown>, create = false): Promise<PageTemplate> {
  if (!TEMPLATE_ID.test(id)) throw new ContentTypeError(TEMPLATE_ID_RULE);
  const existing = await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id);
  if (create && existing) throw new ContentTypeError('Template already exists', 409);
  await lockedTemplateCheck(ctx, create || !existing ? undefined : { before: existing.blocks, after: Array.isArray(input.blocks) ? input.blocks as Block[] : existing.blocks });
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
  await lockedTemplateCheck(ctx);
  const [pages, types] = await Promise.all([vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId), vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId)]);
  if (pages.some(page => page.template === id) || types.some(type => type.template === id || type.allowed_templates?.includes(id))) throw new ContentTypeError('Choose another template for the pages and content types using this template first', 409);
  if (!await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id)) throw new ContentTypeError('Template not found', 404);
  await vstore.deletePageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id);
  await markSiteDirty(ctx.orgId, ctx.siteId, ctx.versionId);
}

/** A locked site's page templates keep their structure (lib/structure-lock): no new or removed templates or blocks. */
async function lockedTemplateCheck(ctx: ContentTypeContext, trees?: { before: Block[] | undefined; after: Block[] | undefined }): Promise<void> {
  try { await assertStructureChange(ctx, trees); } catch (error) {
    if (error instanceof StructureLockedError) throw new ContentTypeError(error.message, 403, error.code);
    throw error;
  }
}
