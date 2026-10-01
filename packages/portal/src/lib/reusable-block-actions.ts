// One entry point for the reusable-block actions on a page, used by the
// session route (editor) and the v1 routes (API, MCP), so both validate and
// write the same way.

import type { Block } from '@typeroll/shared';
import { BlockTemplateError, blockTemplateCopy } from './block-templates-store';
import { loadDraftTree, saveDraftTree } from './page-draft-tree';
import { ReusableBlockError, detachGlobalBlock, insertBlocks, makeGlobal } from './reusable-block-ops';
import { BlockMutationError } from './block-mutations';

interface Ctx { orgId: string; siteId: string; versionId: string }

export type ReusableAction = 'make_global' | 'detach' | 'insert_template';

export async function runReusableAction(ctx: Ctx, pageId: string, action: ReusableAction, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const draft = await loadDraftTree(ctx, pageId);
  if (!draft) return { status: 404, body: { error: 'Page not found' } };
  if (draft.page.content_mode === 'html') return { status: 400, body: { error: 'This page uses HTML mode. Use <x-include name="…" /> for global blocks.' } };
  try {
    if (action === 'make_global') {
      if (typeof body.block_id !== 'string') return { status: 400, body: { error: 'block_id is required' } };
      const result = await makeGlobal(ctx, draft.tree, body.block_id, { name: body.name, id: body.global_block_id });
      await saveDraftTree(ctx, pageId, result.blocks);
      return { status: 200, body: { blocks: result.blocks, reference_id: result.reference_id, global_block: { id: result.partial.id, name: result.partial.name, status: result.partial.status } } };
    }
    if (action === 'detach') {
      if (typeof body.block_id !== 'string') return { status: 400, body: { error: 'block_id is required' } };
      const result = await detachGlobalBlock(ctx, draft.tree, body.block_id);
      await saveDraftTree(ctx, pageId, result.blocks);
      return { status: 200, body: result };
    }
    if (typeof body.template_id !== 'string') return { status: 400, body: { error: 'template_id is required' } };
    if (body.parent_id != null && typeof body.parent_id !== 'string') return { status: 400, body: { error: 'parent_id must be a block id or null' } };
    for (const key of ['slot_index', 'position'] as const) if (body[key] !== undefined && (!Number.isInteger(body[key]) || (body[key] as number) < 0)) return { status: 400, body: { error: `${key} must be a non-negative integer` } };
    const copy: Block[] = await blockTemplateCopy(ctx, body.template_id);
    const result = insertBlocks(draft.tree, copy, { parent_id: body.parent_id as string | null | undefined, slot_index: body.slot_index as number | undefined, position: body.position as number | undefined });
    await saveDraftTree(ctx, pageId, result.blocks);
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof ReusableBlockError || error instanceof BlockTemplateError) return { status: error.status, body: { error: error.message } };
    if (error instanceof BlockMutationError) return { status: error.code === 'not_found' ? 404 : 400, body: { error: error.message } };
    throw error;
  }
}
