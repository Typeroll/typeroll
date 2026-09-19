import { isDeepStrictEqual } from 'node:util';
import { ensureBlockIds, type Block } from '@typeroll/shared';
import { blockTreeInputError } from './block-tree-input';
import { pageAuthorityFields } from '@typeroll/shared';
import { pageAddress, pageContentType, validatePageFields, validatePagePresentation } from './page-fields';
// Editor working copies — server-side scratch state for unsaved edits.
//
// The editors autosave here instead of writing straight to the canonical
// doc, so half-finished edits on a published page can never ride along in
// someone else's deploy. The deliberate "Save" in the Publish menu is a
// normal canonical PUT (revision snapshot, SEO transform, redirect hygiene
// all unchanged) followed by a discard of the working copy — this module is
// dumb storage plus the overlay helper the editor preview uses.
//
// Working copies are per-version and deliberately NOT chain-fallback: a
// branch's unsaved edits belong to that branch only, and a missing copy
// means "no unsaved edits", never "inherit the base version's edits".
//
// Agent surfaces (chat AI, MCP, v1 REST) keep writing canonical docs
// directly and never see working copies. If an agent edits a doc while a
// working copy exists, a later Save overwrites the agent's change for the
// fields the copy carries — same last-write-wins we already accept between
// two humans; the editors surface the unsaved state so it's visible.

import { paths, type Media, type Page, type Partial as PartialDoc, type WorkingCopy, type WorkingCopyKind } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore } from './version-store';
import { snapshotRevision } from './revisions';
import { sanitizeBody } from './sanitize';
import { buildMediaLookup, transformBodyForSeo, lintBodyForSeo } from './seo-transform';
import { PROVENANCE_KEY, applyFieldAuthority, conflictResponse, type WriteActor } from './field-authority';
import { markSiteDirty } from './auto-deploy';
import { isLivePageStatus, retireRedirectsShadowingUrl } from './redirect-hygiene';

export interface WcCtx {
  orgId: string;
  siteId: string;
  versionId: string;
}

export type WcTarget =
  | { kind: 'page'; id: string }
  | { kind: 'partial'; id: string };

/**
 * Per-kind field whitelists. Mirrors the canonical PUT routes' whitelists
 * minus the deliberate-action fields: `status` changes are immediate (they
 * ARE the publish action), and timestamps are always server-stamped.
 * Items are whitelisted dynamically against the collection schema at the
 * API boundary, so no static list here.
 */
export const PAGE_WC_FIELDS = [
  'title', 'slug', 'path', 'parent', 'sort_order', 'template',
  'blocks', 'html_content', 'seo_title', 'seo_description', 'og_image',
  'seo_image_alt', 'canonical_url', 'noindex', 'nofollow', 'alternates', 'lastmod_override', 'json_ld',
  'schema_type', 'service', 'kind', 'author', 'language', 'image_sizes_default',
  'custom_css', 'fields',
] as const;

export const PARTIAL_WC_FIELDS = [
  'name', 'kind', 'blocks', 'html_content',
] as const;

export class WorkingCopyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'WorkingCopyError';
  }
}

/**
 * Parse a URL-tail target (`page/{id}`, `partial/{id}`,
 * `item/{collection}/{itemId}`) — shared by the cookie-auth and v1 REST
 * working-copy route families.
 */
export function parseWcTarget(raw: string | undefined): WcTarget | null {
  const parts = (raw ?? '').split('/').filter(Boolean);
  if (parts[0] === 'page' && parts.length === 2) return { kind: 'page', id: parts[1] };
  if (parts[0] === 'partial' && parts.length === 2) return { kind: 'partial', id: parts[1] };
  return null;
}

/**
 * Whitelist incoming fields per kind. Pages/partials use the static lists
 * (canonical PUT whitelists minus status + timestamps + content_mode —
 * mode switches are deliberate structural actions with their own flow);
 * items are whitelisted dynamically against the collection schema.
 */
export async function filterWcFields(
  ctx: WcCtx,
  target: WcTarget,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Object.hasOwn(fields, 'blocks')) {
    // PUT replacement uses null to clear absent fields, including a former block body.
    const blocks = fields.blocks === null ? [] : fields.blocks;
    const error = blockTreeInputError(blocks);
    if (error) throw new WorkingCopyError(error, 400);
    fields = { ...fields, blocks: ensureBlockIds(structuredClone(blocks) as Block[]) };
  }
  let allowed: Set<string>;
  if (target.kind === 'page') {
    allowed = new Set<string>([...PAGE_WC_FIELDS, 'fields']);
    if (fields.fields !== undefined || 'template' in fields || 'sort_order' in fields || 'blocks' in fields || 'html_content' in fields) {
      const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
      if (!page) throw new WorkingCopyError('Page not found', 404);
      const type = await pageContentType(ctx, page);
      if (!type) throw new WorkingCopyError('Content type not found', 400);
      const error = fields.fields !== undefined ? validatePageFields(type, fields.fields) : null;
      if (error) throw new WorkingCopyError(error, 400);
      const presentationError = await validatePagePresentation(ctx, type, { ...page, ...(await readWorkingCopy(ctx, target))?.fields, ...fields });
      if (presentationError) throw new WorkingCopyError(presentationError, 400);
    }
  } else if (target.kind === 'partial') {
    allowed = new Set<string>(PARTIAL_WC_FIELDS);
  } else {
    throw new WorkingCopyError('Unknown working copy kind', 400);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

export function wcKey(target: WcTarget): string {
  return `${target.kind}--${target.id}`;
}

export async function readWorkingCopy(
  ctx: WcCtx,
  target: WcTarget,
): Promise<WorkingCopy | null> {
  const doc = await getStore().getDoc<WorkingCopy>(
    paths.workingCopy(ctx.orgId, ctx.siteId, wcKey(target), ctx.versionId),
  );
  return doc ?? null;
}

/**
 * Shallow-merge fields into the working copy (creating it if absent).
 * Callers whitelist fields BEFORE calling this — the module trusts its
 * input so the blocks-mutation path can reuse it without re-filtering.
 */
export async function mergeWorkingCopy(
  ctx: WcCtx,
  target: WcTarget,
  fields: Record<string, unknown>,
  updatedBy?: string,
  answerSources?: WorkingCopy['answer_sources'],
): Promise<WorkingCopy> {
  const key = wcKey(target);
  const existing = await readWorkingCopy(ctx, target);
  const page = target.kind === 'page' && fields.fields && !existing?.answer_base
    ? await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id) : null;
  const next: WorkingCopy = {
    id: key,
    kind: target.kind as WorkingCopyKind,
    target_id: target.id,
    fields: mergePageDraftFields(existing?.fields ?? {}, fields, target.kind === 'page'),
    updated_at: new Date().toISOString(),
    ...(updatedBy ? { updated_by: updatedBy } : {}),
    ...(existing?.answer_base ? { answer_base: existing.answer_base } : page ? { answer_base: { fields: page.fields ?? {}, provenance: page._provenance ?? {} } } : {}),
    ...((existing?.answer_sources || answerSources) ? { answer_sources: { ...existing?.answer_sources, ...answerSources } } : {}),
  };
  const { id: _id, ...body } = next;
  await getStore().setDoc(
    paths.workingCopy(ctx.orgId, ctx.siteId, key, ctx.versionId),
    body,
  );
  return next;
}

export async function discardWorkingCopy(ctx: WcCtx, target: WcTarget): Promise<void> {
  await getStore()
    .deleteDoc(paths.workingCopy(ctx.orgId, ctx.siteId, wcKey(target), ctx.versionId))
    .catch(() => {});
}

/** List every working copy on the active version (preview overlay). */
export async function listWorkingCopies(ctx: WcCtx): Promise<WorkingCopy[]> {
  return getStore().listDocs<WorkingCopy>(
    paths.workingCopies(ctx.orgId, ctx.siteId, ctx.versionId),
  );
}

/**
 * Overlay a working copy's fields onto a canonical doc. Shallow — the
 * working copy stores whole-field values (a full blocks tree, a full
 * html_content string), never partial deep merges.
 */
export function overlayWorkingCopy<T extends object>(
  doc: T,
  wc: WorkingCopy | null | undefined,
): T {
  if (!wc || !wc.fields) return doc;
  return mergePageDraftFields(doc as Record<string, unknown>, wc.fields, wc.kind === 'page') as T;
}

/** A custom-field patch replaces each supplied field, preserving other custom fields. */
export function mergePageDraftFields(base: Record<string, unknown>, patch: Record<string, unknown>, page: boolean): Record<string, unknown> {
  const next = { ...base, ...patch };
  if (page && patch.fields && typeof patch.fields === 'object' && !Array.isArray(patch.fields)) {
    next.fields = { ...(base.fields as Record<string, unknown> ?? {}), ...patch.fields as Record<string, unknown> };
  }
  return next;
}

export interface CommitResult {
  committed: boolean;
  seo_warnings: string[];
  auto_redirects: Array<{ from_path: string; to_path: string; status_code: 301 }>;
  retired_redirects: Array<{ from_path: string; to_path: string }>;
}

const NO_COMMIT: CommitResult = {
  committed: false, seo_warnings: [], auto_redirects: [], retired_redirects: [],
};

/**
 * When a commit changes a page's URL, auto-write a 301 from the old URL so
 * inbound links keep working. Skipped when a redirect from that path
 * already exists (the caller's own redirect wins).
 */
async function maybeAutoRedirect(
  ctx: WcCtx,
  oldUrl: string,
  newUrl: string,
): Promise<CommitResult['auto_redirects']> {
  const from = oldUrl.startsWith('/') ? oldUrl : `/${oldUrl}`;
  const to = newUrl.startsWith('/') ? newUrl : `/${newUrl}`;
  if (!from || !to || from === to) return [];
  const existing = await vstore.redirects(ctx.orgId, ctx.siteId, ctx.versionId);
  if (existing.some((r) => r.from_path === from)) return [];
  const id = from.replace(/[\/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_') || `r-${Date.now()}`;
  await getStore().setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`, {
    from_path: from, to_path: to, status_code: 301, auto_generated: true,
  });
  return [{ from_path: from, to_path: to, status_code: 301 }];
}

/**
 * The deliberate Save: promote the working copy's fields onto the canonical
 * doc through the SAME invariants as a direct canonical write — revision
 * snapshot of the pre-edit state, SEO transform for page HTML, sanitize for
 * partial HTML, redirect hygiene (auto-301 from the old URL + retiring
 * redirects that would shadow the new one) — then delete the copy.
 *
 * This is the single commit path shared by the editors' Save button and
 * agents (chat, v1 REST, MCP), so the surfaces can never drift. Status is
 * never in a working copy, so a commit can't change publish state.
 */
export async function commitWorkingCopy(
  ctx: WcCtx,
  target: WcTarget,
  createdBy: string,
  /** Which surface is publishing — drives per-field provenance on items.
   *  Defaults to 'portal' (the editors' Save). */
  actor?: WriteActor,
): Promise<CommitResult> {
  const wc = await readWorkingCopy(ctx, target);
  if (!wc || !wc.fields || Object.keys(wc.fields).length === 0) {
    await discardWorkingCopy(ctx, target);
    return NO_COMMIT;
  }
  const store = getStore();
  const now = new Date().toISOString();

  if (target.kind === 'page') {
    const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
    if (!existing) throw new WorkingCopyError('Page not found', 404);
    if (wc.answer_base && !isDeepStrictEqual(wc.answer_base, { fields: existing.fields ?? {}, provenance: existing._provenance ?? {} }))
      throw new WorkingCopyError('Structured answers changed after this draft started. Reload and review the current answers before saving.', 409);
    const update: Record<string, unknown> = { ...await filterWcFields(ctx, target, wc.fields), date_updated: now };
    {
      const type = await pageContentType(ctx, existing);
      if (!type) throw new WorkingCopyError('Content type not found', 400);
      const authority = applyFieldAuthority({ fields: pageAuthorityFields(type),
        incoming: { ...update, ...(update.fields as Record<string, unknown> ?? {}) }, existing, actor: actor ?? 'portal', actorId: createdBy, now, sources: wc.answer_sources });
      if (authority.rejected.length) throw new WorkingCopyError(conflictResponse(authority.rejected).error, 409);
      if (update.fields) update.fields = { ...existing.fields, ...Object.fromEntries(Object.entries(authority.update).filter(([name]) => type.fields.some(field => field.name === name))) };
      update[PROVENANCE_KEY] = authority.provenance;
    }
    let warnings: string[] = [];
    if (typeof update.html_content === 'string' && update.html_content) {
      const media = await store.listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
      const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
      const defaultSizes =
        (update.image_sizes_default as string | undefined) ||
        existing.image_sizes_default ||
        settings?.image_sizes_default ||
        undefined;
      const transformed = transformBodyForSeo(update.html_content, buildMediaLookup(media), {
        cfImageOrigin: process.env.CF_IMAGE_ORIGIN || undefined,
        defaultSizes,
      });
      update.html_content = transformed;
      warnings = lintBodyForSeo(transformed);
    }
    await snapshotRevision({
      orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId,
      kind: 'page', resourceIds: [target.id],
      doc: existing as unknown as Record<string, unknown>, createdBy,
    });
    await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, target.id, update as Partial<Page>, { actor: actor ?? 'portal', actorId: createdBy, expected: existing, sources: wc.answer_sources });

    let auto_redirects: CommitResult['auto_redirects'] = [];
    let retired_redirects: CommitResult['retired_redirects'] = [];
    if ('slug' in update || 'path' in update || 'fields' in update) {
      const fresh = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
      if (fresh) {
        const oldUrl = await pageAddress(ctx, existing);
        const newUrl = await pageAddress(ctx, fresh);
        if (oldUrl && newUrl) auto_redirects = await maybeAutoRedirect(ctx, oldUrl, newUrl);
        if (newUrl && isLivePageStatus(fresh.status)) {
          retired_redirects = (
            await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, newUrl)
          ).map((r) => ({ from_path: r.from_path, to_path: r.to_path }));
        }
      }
    }
    await discardWorkingCopy(ctx, target);
    await markSiteDirty(ctx.orgId, ctx.siteId);
    return { committed: true, seo_warnings: warnings, auto_redirects, retired_redirects };
  }

  if (target.kind === 'partial') {
    const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
    const update: Record<string, unknown> = { ...wc.fields, date_updated: now };
    if (typeof update.html_content === 'string') {
      const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
      update.html_content = sanitizeBody(update.html_content as string, settings?.iframe_allowed_hosts);
    }
    // Create-on-write defaults, mirroring the canonical partial PUT.
    if (!update.kind) {
      update.kind = target.id === 'header' || target.id === 'footer' ? target.id : 'free';
    }
    if (!existing) {
      if (!update.content_mode) update.content_mode = 'html';
      if (!update.name) update.name = target.id;
      if (!update.status) update.status = 'draft';
    } else {
      await snapshotRevision({
        orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId,
        kind: 'partial', resourceIds: [target.id],
        doc: existing as unknown as Record<string, unknown>, createdBy,
      });
    }
    await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, target.id, update as Partial<PartialDoc>);
    await discardWorkingCopy(ctx, target);
    await markSiteDirty(ctx.orgId, ctx.siteId);
    return { ...NO_COMMIT, committed: true };
  }

  throw new WorkingCopyError('Unknown working copy kind', 400);
}
