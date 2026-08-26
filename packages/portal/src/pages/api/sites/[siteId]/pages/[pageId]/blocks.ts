// Cookie-authenticated block-tree mutations for the portal UI.
// Mirrors the /api/v1/.../pages/{pageId}/blocks routes but uses
// requireSiteAccess (session cookie) instead of API-key auth, so the
// block editor can call them directly from the browser.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { vstore } from '../../../../../../lib/version-store';
import {
  addBlock,
  updateBlock,
  moveBlock,
  removeBlock,
  duplicateBlock,
  BlockMutationError,
} from '../../../../../../lib/block-mutations';
import {
  mergeWorkingCopy,
  readWorkingCopy,
  type WcCtx,
} from '../../../../../../lib/working-copy';
import type { Block } from '@typeroll/shared';

type GuardOk = {
  error: null;
  orgId: string;
  siteId: string;
  versionId: string;
  pageId: string;
  page: import('@typeroll/shared').Page;
};
type GuardErr = { error: Response };

async function guardPage(cookies: any, params: any, locals: any): Promise<GuardOk | GuardErr> {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return { error: guard.response };
  const { session, site, versionId, owner_org_id } = guard.value;
  const pageId = params.pageId;
  if (!pageId) return { error: json({ error: 'Missing pageId' }, 400) };
  const page = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!page) return { error: json({ error: 'Page not found' }, 404) };
  return { error: null, orgId: owner_org_id, siteId: site.id, versionId, pageId, page };
}

/**
 * Buffer model: mutations ALWAYS read from and write to the page's working
 * copy — the tree the user sees stays crash-safe on the server, and nothing
 * ships until the deliberate Save (the Publish menu / commit) promotes it.
 */
async function loadTree(g: GuardOk): Promise<{ tree: Block[]; ctx: WcCtx }> {
  const ctx: WcCtx = { orgId: g.orgId, siteId: g.siteId, versionId: g.versionId };
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: g.pageId });
  return { tree: (wc?.fields?.blocks as Block[] | undefined) ?? g.page.blocks ?? [], ctx };
}

async function persistTree(g: GuardOk, ctx: WcCtx, blocks: Block[]): Promise<void> {
  void g;
  await mergeWorkingCopy(ctx, { kind: 'page', id: g.pageId }, { blocks });
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const g = await guardPage(cookies, params, locals);
  if (g.error) return g.error;
  const { tree } = await loadTree(g);
  return json({
    content_mode: g.page.content_mode,
    blocks: tree,
    html_content: g.page.content_mode === 'html' ? g.page.html_content : undefined,
  });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const g = await guardPage(cookies, params, locals);
  if (g.error) return g.error;
  const body = await request.json().catch(() => null) as {
    block?: Partial<Block>;
    parent_id?: string | null;
    slot_index?: number;
    position?: number;
    /** Clone this block (subtree included, fresh ids) instead of adding a new one. */
    duplicate_of?: string;
  } | null;
  if (!body?.block?.type && !body?.duplicate_of) {
    return json({ error: 'block.type or duplicate_of required' }, 400);
  }
  try {
    const { tree, ctx } = await loadTree(g);
    if (body.duplicate_of) {
      const result = duplicateBlock(tree, body.duplicate_of);
      await persistTree(g, ctx, result.tree);
      return json({ added_id: result.duplicate_id, blocks: result.tree });
    }
    const result = addBlock(tree, {
      block: { id: '', data: {}, ...body.block } as Block,
      parent_id: body.parent_id,
      slot_index: body.slot_index,
      position: body.position,
    });
    await persistTree(g, ctx, result.blocks);
    return json({ added_id: result.added_id, blocks: result.blocks });
  } catch (e) {
    return mutErr(e);
  }
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const g = await guardPage(cookies, params, locals);
  if (g.error) return g.error;
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    data?: Record<string, unknown>;
    style_overrides?: Block['style_overrides'];
    name?: string;
  } | null;
  if (!body?.block_id) return json({ error: 'block_id required' }, 400);
  try {
    const { tree, ctx } = await loadTree(g);
    const blocks = updateBlock(tree, {
      block_id: body.block_id,
      data: body.data,
      style_overrides: body.style_overrides,
      name: body.name,
    });
    await persistTree(g, ctx, blocks);
    return json({ blocks });
  } catch (e) {
    return mutErr(e);
  }
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const g = await guardPage(cookies, params, locals);
  if (g.error) return g.error;
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    target_parent_id?: string | null;
    target_slot_index?: number;
    target_position?: number;
  } | null;
  if (!body?.block_id) return json({ error: 'block_id required' }, 400);
  try {
    const { tree, ctx } = await loadTree(g);
    const blocks = moveBlock(tree, {
      block_id: body.block_id,
      target_parent_id: body.target_parent_id,
      target_slot_index: body.target_slot_index,
      target_position: body.target_position,
    });
    await persistTree(g, ctx, blocks);
    return json({ blocks });
  } catch (e) {
    return mutErr(e);
  }
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const g = await guardPage(cookies, params, locals);
  if (g.error) return g.error;
  const url = new URL(request.url);
  const blockId = url.searchParams.get('block_id');
  if (!blockId) return json({ error: 'block_id query param required' }, 400);
  try {
    const { tree, ctx } = await loadTree(g);
    const blocks = removeBlock(tree, blockId);
    await persistTree(g, ctx, blocks);
    return json({ blocks });
  } catch (e) {
    return mutErr(e);
  }
};

function mutErr(e: unknown): Response {
  if (e instanceof BlockMutationError) {
    return json({ error: e.message, code: e.code }, e.code === 'not_found' ? 404 : 400);
  }
  throw e;
}
