// Block templates: saved section starters that are copied into pages.
// Stored per site (not per version) because they are an authoring library,
// not published content; inserting one copies blocks with new ids.

import {
  BLOCK_TEMPLATE_ID_PATTERN,
  blockTemplateId,
  copyBlocksWithNewIds,
  ensureBlockIds,
  paths,
  validateBlockTemplateInput,
  type Block,
  type BlockTemplate,
} from '@typeroll/shared';
import { getStore } from './datastore';

export class BlockTemplateError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface TemplateCtx { orgId: string; siteId: string }

export async function listBlockTemplates(ctx: TemplateCtx): Promise<BlockTemplate[]> {
  const docs = await getStore().listDocs<BlockTemplate>(paths.blockTemplates(ctx.orgId, ctx.siteId));
  return docs.filter(doc => doc.id).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readBlockTemplate(ctx: TemplateCtx, id: string): Promise<BlockTemplate> {
  if (!BLOCK_TEMPLATE_ID_PATTERN.test(id)) throw new BlockTemplateError('Invalid block template id', 400);
  const doc = await getStore().getDoc<BlockTemplate>(paths.blockTemplate(ctx.orgId, ctx.siteId, id));
  if (!doc) throw new BlockTemplateError(`Block template "${id}" not found`, 404);
  return { ...doc, id };
}

export async function createBlockTemplate(ctx: TemplateCtx, input: unknown): Promise<BlockTemplate> {
  const { value, error } = validateBlockTemplateInput(input);
  if (!value) throw new BlockTemplateError(error ?? 'Invalid block template', 400);
  const existing = await listBlockTemplates(ctx);
  const requested = (input as { id?: unknown }).id;
  if (requested !== undefined && (typeof requested !== 'string' || !BLOCK_TEMPLATE_ID_PATTERN.test(requested))) throw new BlockTemplateError('id must be lowercase letters, digits and hyphens', 400);
  if (typeof requested === 'string' && existing.some(doc => doc.id === requested)) throw new BlockTemplateError(`A block template with id "${requested}" already exists`, 409);
  const id = typeof requested === 'string' ? requested : blockTemplateId(value.name!, existing.map(doc => doc.id));
  const now = new Date().toISOString();
  const template: BlockTemplate = {
    id, name: value.name!, ...(value.description ? { description: value.description } : {}),
    blocks: ensureBlockIds(JSON.parse(JSON.stringify(value.blocks))), created_at: now, updated_at: now,
  };
  const { id: _id, ...doc } = template;
  await getStore().setDoc(paths.blockTemplate(ctx.orgId, ctx.siteId, id), doc);
  return template;
}

export async function updateBlockTemplate(ctx: TemplateCtx, id: string, input: unknown): Promise<BlockTemplate> {
  const current = await readBlockTemplate(ctx, id);
  const { value, error } = validateBlockTemplateInput(input, true);
  if (!value) throw new BlockTemplateError(error ?? 'Invalid block template', 400);
  if ((input as { id?: unknown }).id !== undefined && (input as { id?: unknown }).id !== id) throw new BlockTemplateError('A block template id cannot change', 400);
  const next: BlockTemplate = {
    ...current, ...value,
    ...(value.blocks ? { blocks: ensureBlockIds(JSON.parse(JSON.stringify(value.blocks))) } : {}),
    updated_at: new Date().toISOString(),
  };
  if (value.description === '') delete next.description;
  const { id: _id, ...doc } = next;
  await getStore().setDoc(paths.blockTemplate(ctx.orgId, ctx.siteId, id), doc);
  return next;
}

export async function deleteBlockTemplate(ctx: TemplateCtx, id: string): Promise<void> {
  await readBlockTemplate(ctx, id);
  await getStore().deleteDoc(paths.blockTemplate(ctx.orgId, ctx.siteId, id));
}

/** The template's blocks as a fresh copy, ready to insert into a page. */
export async function blockTemplateCopy(ctx: TemplateCtx, id: string): Promise<Block[]> {
  return copyBlocksWithNewIds((await readBlockTemplate(ctx, id)).blocks);
}
