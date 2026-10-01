// Page-tree operations for reusable blocks, shared by the editor routes,
// the v1 API and MCP:
//
// - makeGlobal: move a block (with its subtree) into a new global block and
//   leave a core/global_block reference in its place.
// - detach: replace a reference with a local copy of the global block's
//   blocks, so this page can change them on its own. The copy is what the
//   editors show for the global block: its unsaved draft (working copy) on
//   this site version when there is one, otherwise the saved global block.
// - insertTemplate: copy a block template's blocks into the tree.

import {
  GLOBAL_BLOCK_TYPE_ID,
  blockTemplateId,
  copyBlocksWithNewIds,
  type Block,
  type Partial as PartialDoc,
} from '@typeroll/shared';
import { addBlock, findBlock, newBlockId } from './block-mutations';
import { vstore } from './version-store';
import { overlayWorkingCopy, readWorkingCopy } from './working-copy';
import { sanitizeBody } from './sanitize';

export class ReusableBlockError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface Ctx { orgId: string; siteId: string; versionId: string }

const GLOBAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function replaceBlock(tree: Block[], blockId: string, replacement: Block[]): Block[] {
  const replace = (list: Block[]): Block[] => list.flatMap(block => block.id === blockId ? replacement : [{
    ...block,
    ...(block.children ? { children: replace(block.children) } : {}),
    ...(block.slots ? { slots: block.slots.map(replace) } : {}),
  }]);
  return replace(tree);
}

/** Move a block into a new published global block and reference it in place. */
export async function makeGlobal(ctx: Ctx, tree: Block[], blockId: string, input: { name?: unknown; id?: unknown }): Promise<{ blocks: Block[]; partial: PartialDoc; reference_id: string }> {
  const found = findBlock(tree, blockId);
  if (!found) throw new ReusableBlockError(`Block "${blockId}" not found`, 404);
  if (found.block.type === GLOBAL_BLOCK_TYPE_ID) throw new ReusableBlockError('This block is already a global block reference', 400);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : (found.block.name ?? 'Global block');
  const existing = await vstore.partials(ctx.orgId, ctx.siteId, ctx.versionId);
  let id: string;
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !GLOBAL_ID.test(input.id) || ['header', 'footer'].includes(input.id)) throw new ReusableBlockError('id must be kebab-case [a-z0-9-], not header or footer', 400);
    if (existing.some(partial => partial.id === input.id)) throw new ReusableBlockError(`A global block with id "${input.id}" already exists`, 409);
    id = input.id;
  } else {
    id = blockTemplateId(name, [...existing.map(partial => partial.id), 'header', 'footer']);
  }
  const content = JSON.parse(JSON.stringify(found.block)) as Block;
  const partial: PartialDoc = { id, name, kind: 'free', content_mode: 'blocks', blocks: [content], status: 'published', date_updated: new Date().toISOString() };
  const { id: _id, ...doc } = partial;
  await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, id, doc);
  const reference: Block = { id: newBlockId(), type: GLOBAL_BLOCK_TYPE_ID, name, data: { global_block_id: id } };
  return { blocks: replaceBlock(tree, blockId, [reference]), partial, reference_id: reference.id };
}

/**
 * Replace a global block reference with an editable local copy of its content.
 *
 * Copies what the global block editor and the page editor preview show: the
 * global block's draft (its working copy on this site version, shared by
 * everyone editing that version) when it has one, otherwise the saved
 * global block. `copied_from` says which.
 */
export async function detachGlobalBlock(ctx: Ctx, tree: Block[], blockId: string): Promise<{ blocks: Block[]; added_ids: string[]; copied_from: 'draft' | 'saved' }> {
  const found = findBlock(tree, blockId);
  if (!found) throw new ReusableBlockError(`Block "${blockId}" not found`, 404);
  if (found.block.type !== GLOBAL_BLOCK_TYPE_ID) throw new ReusableBlockError('Only global block references can be detached', 400);
  const id = String(found.block.data?.global_block_id ?? '');
  const saved = id ? await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id) : null;
  if (!saved || saved.kind !== 'free') throw new ReusableBlockError(`Global block "${id}" not found`, 404);
  const draft = await readWorkingCopy(ctx, { kind: 'partial', id });
  const partial = overlayWorkingCopy(saved, draft);
  // Saved HTML is sanitized at save; a draft's HTML is not yet.
  const html = draft && typeof draft.fields?.html_content === 'string'
    ? sanitizeBody(partial.html_content ?? '', (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId))?.iframe_allowed_hosts)
    : partial.html_content ?? '';
  const copy: Block[] = partial.content_mode === 'blocks'
    ? copyBlocksWithNewIds(partial.blocks ?? [])
    : [{ id: newBlockId(), type: 'core/html', data: { html } }];
  if (!copy.length) throw new ReusableBlockError(`Global block "${id}" is empty`, 400);
  return { blocks: replaceBlock(tree, blockId, copy), added_ids: copy.map(block => block.id), copied_from: draft ? 'draft' : 'saved' };
}

/** Insert copies of blocks (a template's) at a position. */
export function insertBlocks(tree: Block[], blocks: Block[], at: { parent_id?: string | null; slot_index?: number; position?: number }): { blocks: Block[]; added_ids: string[] } {
  let next = tree;
  const added: string[] = [];
  blocks.forEach((block, index) => {
    const result = addBlock(next, { block, parent_id: at.parent_id ?? null, slot_index: at.slot_index, position: at.position === undefined ? undefined : at.position + index });
    next = result.blocks;
    added.push(result.added_id);
  });
  return { blocks: next, added_ids: added };
}
