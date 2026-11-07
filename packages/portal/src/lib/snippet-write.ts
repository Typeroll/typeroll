// Saving live snippets: one path for the v1 API, the portal's cookie routes,
// MCP and the in-app assistant.
//
// A snippet is a small piece of content a site keeps outside its
// publication (today's lunch, a notice). It is not versioned: one copy per
// site at paths.snippet. Every save validates it with the published-page
// sanitizer, stamps updated_at (always later than the saved one, so the
// revision check holds) and updated_by, and then writes the public live file
// so the live site shows it within a minute. A live file that cannot be
// written does not undo the save; the result says why
// (`live: { published: false, reason }`) and the next publication shows it.
//
// Anyone who may edit content (write permission) may change snippets.

import {
  MAIN_VERSION_ID, MAX_SNIPPETS, paths, siteTimeZone, snippetFile, validateSnippet,
  type SharePermission, type Snippet, type SnippetError,
} from '@typeroll/shared';
import { getStore } from './datastore';
import { laterStamp, menuIdFromName } from './menu-write';
import { sanitizeBody } from './sanitize';
import { vstore } from './version-store';
import { deleteLiveFile, liveFilesTarget, publishLiveFile, type LiveWriteResult } from './publishing/live-files';

export interface SnippetCtx { orgId: string; siteId: string }

export class SnippetSaveError extends Error {
  constructor(message: string, readonly status: number, readonly errors?: SnippetError[]) { super(message); }
}

export interface SnippetSaveOptions {
  permission: SharePermission;
  /** Who saves: a person's email, `api-key:<prefix>`, `extension:<installation>` or `chat-ai`. */
  updatedBy: string;
  /** The `updated_at` the caller read; '' when the snippet did not exist yet. */
  expectedUpdatedAt?: string;
}

const RANK: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function describe(errors: SnippetError[]): string {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
}

function requireWrite(permission: SharePermission): void {
  if (RANK[permission] < RANK.write) throw new SnippetSaveError('Changing snippets needs write permission on the site', 403);
}

export function snippetIdFromName(name: string): string {
  return menuIdFromName(name).replace(/^menu$/, 'snippet');
}

/** The site's main settings decide the sanitizer's iframe hosts and the time zone of dated entries. */
async function siteContext(ctx: SnippetCtx) {
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
  return {
    sanitize: (html: string) => sanitizeBody(html, settings?.iframe_allowed_hosts),
    timeZone: siteTimeZone(settings ?? undefined),
  };
}

export async function listSnippets(ctx: SnippetCtx): Promise<Snippet[]> {
  const docs = await getStore().listDocs<Snippet>(paths.snippets(ctx.orgId, ctx.siteId));
  return docs.map((doc) => ({ ...doc, id: doc.id })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function readSnippet(ctx: SnippetCtx, id: string): Promise<Snippet | null> {
  if (!ID.test(id)) return null;
  return getStore().getDoc<Snippet>(paths.snippet(ctx.orgId, ctx.siteId, id));
}

/** Writes the snippet's public live file. */
export async function publishSnippetLive(ctx: SnippetCtx, snippet: Snippet, timeZone?: string): Promise<LiveWriteResult> {
  const zone = timeZone ?? (await siteContext(ctx)).timeZone;
  return publishLiveFile(ctx.orgId, ctx.siteId, snippet.id, snippetFile(snippet, zone));
}

/**
 * Creates or replaces a whole snippet. `mode: 'create'` refuses an existing
 * id (409); `replace` creates a missing snippet unless the caller expected
 * one (a non-empty expected_updated_at), and refuses a stale one (409).
 */
export async function saveSnippet(
  ctx: SnippetCtx, input: unknown, options: SnippetSaveOptions & { id?: string; mode: 'create' | 'replace' },
): Promise<{ snippet: Snippet; created: boolean; live: LiveWriteResult }> {
  requireWrite(options.permission);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SnippetSaveError('A snippet is an object', 400, [{ path: '', message: 'A snippet is an object' }]);
  const raw = { ...(input as Record<string, unknown>) };
  delete raw.updated_at; delete raw.updated_by; delete raw.expected_updated_at;
  const id = options.id ?? (typeof raw.id === 'string' && raw.id ? raw.id : snippetIdFromName(String(raw.name ?? '')));
  if (options.id && raw.id !== undefined && raw.id !== options.id) throw new SnippetSaveError(`The snippet id in the body (${String(raw.id)}) differs from the address (${options.id})`, 400, [{ path: 'id', message: 'Must match the address' }]);
  raw.id = id;
  const context = await siteContext(ctx);
  const { snippet, errors } = validateSnippet(raw, context.sanitize);
  if (!snippet) throw new SnippetSaveError(`The snippet is not valid: ${describe(errors)}`, 400, errors);
  const path = paths.snippet(ctx.orgId, ctx.siteId, id);
  const store = getStore();
  const existing = await store.getDoc<Snippet>(path);
  if (existing && options.mode === 'create') throw new SnippetSaveError(`A snippet called ${id} already exists. Choose another id, or replace it with PUT.`, 409);
  const expected = options.expectedUpdatedAt;
  if (expected !== undefined && expected !== (existing?.updated_at ?? ''))
    throw new SnippetSaveError('The snippet was saved by someone else after you read it. Read it again and reapply your change.', 409);
  if (!existing && (await store.listDocs(paths.snippets(ctx.orgId, ctx.siteId), { limit: MAX_SNIPPETS })).length >= MAX_SNIPPETS)
    throw new SnippetSaveError(`A site has at most ${MAX_SNIPPETS} snippets. Delete one you no longer use first.`, 409);
  const saved: Snippet = { ...snippet, id, updated_by: options.updatedBy.slice(0, 200), updated_at: laterStamp(existing?.updated_at) };
  const { id: _id, ...body } = saved;
  if (!(await store.compareAndReplaceDoc(path, existing, body)))
    throw new SnippetSaveError('The snippet was saved by someone else at the same time. Read it again and reapply your change.', 409);
  return { snippet: saved, created: !existing, live: await publishSnippetLive(ctx, saved, context.timeZone) };
}

/** Deletes a snippet and its live file. */
export async function deleteSnippet(ctx: SnippetCtx, id: string, options: Pick<SnippetSaveOptions, 'permission' | 'expectedUpdatedAt'>): Promise<{ live: { deleted: boolean; reason?: string } }> {
  requireWrite(options.permission);
  const existing = await readSnippet(ctx, id);
  if (!existing) throw new SnippetSaveError('Snippet not found', 404);
  if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== (existing.updated_at ?? ''))
    throw new SnippetSaveError('The snippet was saved by someone else after you read it. Read it again before deleting it.', 409);
  await getStore().deleteDoc(paths.snippet(ctx.orgId, ctx.siteId, id));
  return { live: await deleteLiveFile(ctx.orgId, ctx.siteId, id) };
}

/** Where this site's live files are served, for list responses and the editor. */
export async function snippetLiveInfo(ctx: SnippetCtx): Promise<{ base_url: string | null; reason?: string }> {
  const target = await liveFilesTarget(ctx.orgId, ctx.siteId).catch(() => null);
  if (!target) return { base_url: null, reason: 'The live file target could not be read.' };
  return target.available ? { base_url: target.base_url } : { base_url: null, reason: target.message };
}

/** The JSON a route answers a refused save with: `{ error, errors? }`. */
export function snippetFailureBody(error: unknown): { status: number; body: { error: string; errors?: SnippetError[] } } | null {
  if (!(error instanceof SnippetSaveError)) return null;
  return { status: error.status, body: { error: error.message, ...(error.errors ? { errors: error.errors } : {}) } };
}

/** Who a v1 caller is, for updated_by. */
export function apiUpdatedBy(keyPrefix: string): string {
  return keyPrefix.startsWith('extension:') ? keyPrefix : `api-key:${keyPrefix}`;
}
