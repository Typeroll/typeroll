// The universal content-write entry for AGENT surfaces (chat AI, v1 REST,
// MCP). Implements the platform's buffer model:
//
//   ALL content writes land in the working copy (the draft layer).
//   Publish state (`status`, `date_published`) applies immediately.
//   Save is always explicit — `save: true` commits in the same call,
//   commitWorkingCopy() is the standalone Save.
//
// The portal editors implement the same model client-side (autosave to the
// working copy, Publish-menu Save commits); this module is the server-side
// equivalent so every surface shares one write semantics. Deploys, shared
// preview links and default previews only ever see committed content.

import type { Page } from '@typeroll/shared';
import { vstore } from './version-store';
import type { WriteActor } from './field-authority';
import { markSiteDirty } from './auto-deploy';
import { sanitizeBody } from './sanitize';
import { diffSanitizationDetails, type SanitizationWarningDetail } from './sanitize-warnings';
import { pageUrlFromDoc, validatePathField } from './page-paths';
import { isLivePageStatus, retireRedirectsShadowingUrl } from './redirect-hygiene';
import {
  commitWorkingCopy,
  filterWcFields,
  mergeWorkingCopy,
  WorkingCopyError,
  type CommitResult,
  type WcCtx,
  type WcTarget,
} from './working-copy';

/** Publish-state fields — never drafted, always applied to the saved doc.
 *  publish_at/unpublish_at are the scheduled-publishing timers the sweep
 *  (lib/scheduled-publish.ts) fires on; like status they must never ride
 *  in a working copy. Items share the page's schedule fields. */
const IMMEDIATE_PAGE_FIELDS = ['status', 'date_published', 'publish_at', 'unpublish_at'] as const;
const IMMEDIATE_ITEM_FIELDS = ['status', 'publish_at', 'unpublish_at'] as const;
const IMMEDIATE_FIELDS = ['status'] as const;

export interface ContentWriteResult {
  /** Content fields staged in the working copy. */
  staged: string[];
  /** Publish-state fields applied to the saved doc right away. */
  applied_immediately: string[];
  /** Whether `save: true` committed the working copy. */
  committed: boolean;
  seo_warnings: string[];
  sanitization_warnings: string[];
  sanitization_details: SanitizationWarningDetail[];
  auto_redirects: CommitResult['auto_redirects'];
  retired_redirects: CommitResult['retired_redirects'];
}

/**
 * Stage a content write. Throws WorkingCopyError on invalid input/missing
 * targets so callers can map to their surface's error shape.
 */
export async function applyContentWrite(
  ctx: WcCtx,
  target: WcTarget,
  rawFields: Record<string, unknown>,
  opts: { save?: boolean; updatedBy: string; actor?: WriteActor },
): Promise<ContentWriteResult> {
  const result: ContentWriteResult = {
    staged: [],
    applied_immediately: [],
    committed: false,
    seo_warnings: [],
    sanitization_warnings: [],
    sanitization_details: [],
    auto_redirects: [],
    retired_redirects: [],
  };
  const fields = { ...rawFields };

  // Page-specific input validation — fail fast at draft-write time, not
  // at commit when the agent has already moved on.
  if (target.kind === 'page') {
    if (fields.slug !== undefined && String(fields.slug).includes('/')) {
      throw new WorkingCopyError(
        'Invalid slug: page slugs must be a single path segment without slashes. Use the `path` field for nested URLs.',
        400,
      );
    }
    if ('path' in fields) {
      const pathCheck = validatePathField(fields.path as string | undefined);
      if (!pathCheck.ok) throw new WorkingCopyError(`Invalid path: ${pathCheck.error}`, 400);
      if (pathCheck.path === '') delete fields.path;
      else fields.path = pathCheck.path;
    }
  }

  // Sanitize HTML at draft-write time so the agent sees the warnings in the
  // write response (the renderer re-sanitizes at output; commit re-runs the
  // partial sanitize — both idempotent).
  if (typeof fields.html_content === 'string' && fields.html_content) {
    const raw = fields.html_content;
    const clean = sanitizeBody(raw);
    fields.html_content = clean;
    const diff = diffSanitizationDetails(raw, clean);
    result.sanitization_warnings = diff.messages;
    result.sanitization_details = diff.details;
  }

  // Split publish-state fields from content fields.
  const immediateKeys = target.kind === 'page'
    ? IMMEDIATE_PAGE_FIELDS
    : target.kind === 'item' ? IMMEDIATE_ITEM_FIELDS : IMMEDIATE_FIELDS;
  const immediate: Record<string, unknown> = {};
  for (const k of immediateKeys) {
    if (k in fields) {
      immediate[k] = fields[k];
      delete fields[k];
    }
  }

  // Content → working copy (whitelisted per kind).
  const content = await filterWcFields(ctx, target, fields);
  if (Object.keys(content).length > 0) {
    await mergeWorkingCopy(ctx, target, content, opts.updatedBy);
    result.staged = Object.keys(content);
  }

  // Publish state → saved doc, right away.
  if (Object.keys(immediate).length > 0) {
    await applyImmediate(ctx, target, immediate, result);
    result.applied_immediately = Object.keys(immediate);
  }

  if (opts.save) {
    const commit = await commitWorkingCopy(ctx, target, opts.updatedBy, opts.actor);
    result.committed = commit.committed;
    result.seo_warnings = commit.seo_warnings;
    result.auto_redirects = [...result.auto_redirects, ...commit.auto_redirects];
    result.retired_redirects = [...result.retired_redirects, ...commit.retired_redirects];
  }
  return result;
}

async function applyImmediate(
  ctx: WcCtx,
  target: WcTarget,
  immediate: Record<string, unknown>,
  result: ContentWriteResult,
): Promise<void> {
  const now = new Date().toISOString();
  if (target.kind === 'page') {
    const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
    if (!existing) throw new WorkingCopyError('Page not found', 404);
    await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, target.id, {
      ...immediate,
      date_updated: now,
    } as Partial<Page>);
    // A page flipping live may take over a URL an existing redirect still
    // claims — retire it, or the deploy's `_redirects` shadows the page.
    if ('status' in immediate) {
      const fresh = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
      if (fresh && isLivePageStatus(fresh.status)) {
        result.retired_redirects = (
          await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, pageUrlFromDoc(fresh))
        ).map((r) => ({ from_path: r.from_path, to_path: r.to_path }));
      }
    }
    return;
  }
  if (target.kind === 'partial') {
    const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, target.id);
    // Partials are create-on-write: a status write on a not-yet-committed
    // partial creates the shell doc (the content stays in the working copy).
    const defaults: Record<string, unknown> = existing ? {} : {
      name: target.id,
      kind: target.id === 'header' || target.id === 'footer' ? target.id : 'free',
      content_mode: 'html',
      html_content: '',
    };
    await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, target.id, {
      ...defaults,
      ...immediate,
      date_updated: now,
    });
    return;
  }
  const existing = await vstore.collectionItem(
    ctx.orgId, ctx.siteId, ctx.versionId, target.collection, target.id,
  );
  if (!existing) throw new WorkingCopyError('Item not found', 404);
  await vstore.writeCollectionItem(ctx.orgId, ctx.siteId, ctx.versionId, target.collection, target.id, {
    ...immediate,
    updated_at: now,
  });
  // Publish-state changes (status, publish_at) change what the built site
  // contains just as much as a content edit, so they mark the site dirty too.
  await markSiteDirty(ctx.orgId, ctx.siteId);
}
