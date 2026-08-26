// Shared abstraction for "things that hold a Block[] tree" — pages,
// partials, and page templates. The block-instance tools (add_block,
// update_block, move_block, remove_block, duplicate_block,
// set_block_responsive) all operate on a container; the only thing
// that differs across kinds is HOW you load + write the doc.
//
// Templates and partials don't go through vstore.writePage's full
// snapshot/COW flow, but they do live under the active version's
// per-site docs the same way. Each writer here funnels through the
// canonical write path for its kind so deploys see the change.
//
// This is the surface the new generalised block-instance routes use
// (and the chat AI's tool handlers). The legacy /pages/{id}/blocks
// routes still work via the page-targeted shorthand.

import { paths, ensureBlockIds, type Block, type CollectionDef, type Page, type Partial as PartialDoc, type PageTemplate } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore } from './version-store';
import { mergeWorkingCopy, readWorkingCopy, type WcTarget } from './working-copy';

export type BlockContainerKind = 'page' | 'partial' | 'template' | 'item_template';

export interface BlockContainerTarget {
  kind: BlockContainerKind;
  id: string;
}

/**
 * Normalise input into a target. Accepts the explicit `target` shape OR
 * the legacy `page_id` shorthand. Returns undefined if neither resolves.
 */
export function normaliseTarget(input: {
  target?: { kind?: string; id?: string } | null;
  page_id?: string;
}): BlockContainerTarget | undefined {
  if (input.target?.kind && input.target.id) {
    const k = input.target.kind;
    if (k === 'page' || k === 'partial' || k === 'template' || k === 'item_template') {
      return { kind: k, id: input.target.id };
    }
    return undefined;
  }
  if (input.page_id) return { kind: 'page', id: input.page_id };
  return undefined;
}

export interface LoadedContainer {
  target: BlockContainerTarget;
  blocks: Block[];
  /** Filled in for pages — used for action.preview_url. */
  pageSlug?: string;
  pageTitle?: string;
  /** Underlying doc — handed back so writers can re-serialize alongside other fields. */
  raw: Page | PartialDoc | PageTemplate | CollectionDef;
  content_mode: 'blocks' | 'html';
}

export class ContainerError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ContainerError';
  }
}

/**
 * The buffer model: pages and partials ALWAYS read/write their block trees
 * through the working copy — every mutation is a draft until an explicit
 * commit (the editor's Save, commit_working_copy, or `save: true` on a
 * field write). Templates and item templates have no working copies (they
 * are structural, low-churn docs) and keep writing directly.
 */
function wcTargetFor(target: BlockContainerTarget): WcTarget | null {
  if (target.kind === 'page') return { kind: 'page', id: target.id };
  if (target.kind === 'partial') return { kind: 'partial', id: target.id };
  return null;
}

/**
 * Load the addressed container's block tree. Throws ContainerError with
 * a status code on misses. Pages route through vstore (chain-aware
 * reads); partials and templates load directly through the datastore
 * since they don't have the same per-page revision shape.
 */
export async function loadContainer(
  target: BlockContainerTarget,
  ctx: { orgId: string; siteId: string; versionId: string },
): Promise<LoadedContainer> {
  // The tree the caller sees is the working copy's tree when one exists,
  // else the saved tree (the first draft write forks from it). Mode checks
  // always run against the saved doc — a working copy can't change
  // content_mode.
  const wcBlocks = async (): Promise<Block[] | undefined> => {
    const wcTarget = wcTargetFor(target);
    if (!wcTarget) return undefined;
    const wc = await readWorkingCopy(ctx, wcTarget);
    return wc?.fields?.blocks as Block[] | undefined;
  };

  if (target.kind === 'page') {
    const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
    if (!page) throw new ContainerError(`Page ${target.id} not found`, 404);
    if (page.content_mode !== 'blocks') {
      throw new ContainerError(`Page is in ${page.content_mode}-mode`, 400);
    }
    return {
      target,
      blocks: (await wcBlocks()) ?? page.blocks ?? [],
      pageSlug: page.slug,
      pageTitle: page.title,
      raw: page,
      content_mode: page.content_mode,
    };
  }

  const store = getStore();
  if (target.kind === 'partial') {
    const partial = await store.getDoc<PartialDoc>(
      paths.partial(ctx.orgId, ctx.siteId, target.id, ctx.versionId),
    );
    if (!partial) throw new ContainerError(`Partial ${target.id} not found`, 404);
    if (partial.content_mode !== 'blocks') {
      throw new ContainerError(
        `Partial ${target.id} is in html-mode; use update_partial to edit the HTML body.`,
        400,
      );
    }
    return {
      target,
      blocks: (await wcBlocks()) ?? partial.blocks ?? [],
      raw: partial,
      content_mode: 'blocks',
    };
  }

  if (target.kind === 'template') {
    const tpl = await store.getDoc<PageTemplate>(
      paths.pageTemplate(ctx.orgId, ctx.siteId, target.id, ctx.versionId),
    );
    if (!tpl) throw new ContainerError(`Template ${target.id} not found`, 404);
    return {
      target,
      blocks: tpl.blocks ?? [],
      raw: tpl,
      content_mode: 'blocks',  // templates are always block trees
    };
  }

  // item_template — target.id is the collection name. The container's
  // "blocks" is the collection's item_template_blocks field. When the
  // collection still uses item_template_html, the loaded blocks array
  // is empty — the caller's first add_block call grows it from there
  // and the renderer flips to the block path automatically.
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
  if (!coll) throw new ContainerError(`Collection ${target.id} not found`, 404);
  return {
    target,
    blocks: coll.item_template_blocks ?? [],
    raw: coll,
    content_mode: 'blocks',
  };
}

/**
 * Persist a new block tree back to the container. Pages route through
 * vstore.writePage (revisions, SEO transform, all the usual page-save
 * plumbing); partials and templates write directly to the datastore
 * with date_updated stamped on partials so the "pending deploy" UI
 * picks them up.
 */
export async function writeContainer(
  target: BlockContainerTarget,
  blocks: Block[],
  ctx: { orgId: string; siteId: string; versionId: string },
  raw: Page | PartialDoc | PageTemplate | CollectionDef,
): Promise<void> {
  // Every container write funnels through here — normalise missing block
  // ids (hand-authored trees) so the renderer + per-block tools can
  // address every block.
  blocks = ensureBlockIds(blocks);
  const wcTarget = wcTargetFor(target);
  if (wcTarget) {
    // Buffer model: page/partial block trees land in the working copy;
    // an explicit commit (editor Save / commit_working_copy / save:true)
    // promotes them through the canonical write.
    await mergeWorkingCopy(ctx, wcTarget, { blocks });
    return;
  }

  const store = getStore();
  if (target.kind === 'template') {
    const next: PageTemplate = {
      ...(raw as PageTemplate),
      blocks,
      date_updated: new Date().toISOString(),
    };
    await store.setDoc(
      paths.pageTemplate(ctx.orgId, ctx.siteId, target.id, ctx.versionId),
      next,
    );
    return;
  }

  // item_template — write the block tree onto the collection doc's
  // item_template_blocks field. Goes through vstore.writeCollection so
  // any pending revision flow stays consistent.
  await vstore.writeCollection(ctx.orgId, ctx.siteId, ctx.versionId, target.id, {
    item_template_blocks: blocks,
  });
}

/**
 * Human-readable name for the container — surfaces in the action.description
 * payload returned to the chat client ("Edited block in header partial",
 * not "Edited block in <kind=partial,id=header>").
 */
export function targetLabel(target: BlockContainerTarget, loaded?: LoadedContainer): string {
  if (target.kind === 'page') return loaded?.pageTitle ? `page ${loaded.pageTitle}` : `page ${target.id}`;
  if (target.kind === 'partial') return `partial ${target.id}`;
  if (target.kind === 'template') return `template ${target.id}`;
  return `item template for ${target.id}`;
}
