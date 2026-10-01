// The block tree an edit works on: the page's working copy (draft) when it
// has one, else the saved page. Writes always go to the working copy, like
// the other block mutations; nothing reaches the live site until a save.

import type { Block, Page } from '@typeroll/shared';
import { vstore } from './version-store';
import { mergeWorkingCopy, readWorkingCopy } from './working-copy';

interface Ctx { orgId: string; siteId: string; versionId: string }

export async function loadDraftTree(ctx: Ctx, pageId: string): Promise<{ page: Page; tree: Block[] } | null> {
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return null;
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  return { page, tree: (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [] };
}

export async function saveDraftTree(ctx: Ctx, pageId: string, blocks: Block[]): Promise<void> {
  await mergeWorkingCopy(ctx, { kind: 'page', id: pageId }, { blocks });
}
