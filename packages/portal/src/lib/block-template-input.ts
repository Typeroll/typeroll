// Build a block template body from `from: { page_id, block_id }`: a copy of
// that block (with its subtree) from the page draft. Other bodies pass through.

import { findBlock } from './block-mutations';
import { BlockTemplateError } from './block-templates-store';
import { loadDraftTree } from './page-draft-tree';

interface Ctx { orgId: string; siteId: string; versionId: string }

export async function templateInputFromPage(ctx: Ctx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body.from === undefined) return body;
  const { from, ...rest } = body;
  if (!from || typeof from !== 'object' || Array.isArray(from)) throw new BlockTemplateError('from must be { page_id, block_id }', 400);
  const { page_id, block_id } = from as Record<string, unknown>;
  if (typeof page_id !== 'string' || typeof block_id !== 'string') throw new BlockTemplateError('from must be { page_id, block_id }', 400);
  if (rest.blocks !== undefined) throw new BlockTemplateError('Send either blocks or from, not both', 400);
  const draft = await loadDraftTree(ctx, page_id);
  if (!draft) throw new BlockTemplateError('Page not found', 404);
  const found = findBlock(draft.tree, block_id);
  if (!found) throw new BlockTemplateError(`Block "${block_id}" not found on that page`, 404);
  return { ...rest, name: rest.name ?? found.block.name, blocks: [JSON.parse(JSON.stringify(found.block))] };
}
