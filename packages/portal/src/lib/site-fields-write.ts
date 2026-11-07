// Saving site fields: one path for the v1 API, the portal's cookie routes and
// the in-app assistant.
//
// Site fields are one document per version: the settings pages a builder
// defines (`groups`) and the values editors fill in (`values`). Like menus
// they have revisions but no working copy; a save replaces the document at
// the active version and reaches the live site with the next publication.
//
// Fields marked `live` are also published as the live file `_fields.json`
// when a save on main changes them (lib/live-site-fields.ts); the result is
// returned as `live` and a failed live write never undoes the save.
//
// Permissions follow the portal's roles:
//   - definitions (and restoring a revision, which restores them) are design
//     work: site admin, or a builder (`design`);
//   - values in a group with `access: 'admin'` need site admin;
//   - other values need write (anyone who may edit content).

import {
  siteFieldGroupOf, validateSiteFieldGroups, validateSiteFieldValues,
  type SharePermission, type SiteFieldError, type SiteFieldGroup, type SiteFields,
} from '@typeroll/shared';
import { snapshotRevision } from './revisions';
import { publishLiveSiteFields } from './live-site-fields';
import { SiteFieldsWriteConflict, vstore } from './version-store';

export interface SiteFieldsCtx { orgId: string; siteId: string; versionId: string }

export interface SiteFieldsSaveOptions {
  /** The caller's permission on the site. */
  permission: SharePermission;
  /** Design work (SiteContext.design): a builder defines settings pages without admin. */
  design?: boolean;
  updatedBy: string;
  /** The `updated_at` the caller read; '' when nothing was saved yet. */
  expectedUpdatedAt?: string;
  note?: string;
}

export class SiteFieldsSaveError extends Error {
  constructor(message: string, readonly status: number, readonly errors?: SiteFieldError[]) { super(message); }
}

const RANK: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };

function describe(errors: SiteFieldError[]): string {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
}

/** The root field name of a value path: `hours.days[0].opens` → `hours`. */
function rootName(path: string): string {
  return path.split(/[.[]/)[0] ?? path;
}

/**
 * A new `updated_at`, always later than the saved one: the revision check
 * compares it, so two saves in the same millisecond must not share one.
 */
function nextStamp(existing: SiteFields): string {
  const now = Date.now();
  const previous = existing.updated_at ? Date.parse(existing.updated_at) : NaN;
  return new Date(Number.isFinite(previous) && previous >= now ? previous + 1 : now).toISOString();
}

function checkExpected(existing: SiteFields, expected: string | undefined): void {
  if (expected !== undefined && expected !== (existing.updated_at ?? ''))
    throw new SiteFieldsSaveError('The site fields were saved by someone else after you read them. Read them again and reapply your change.', 409);
}

/** A saved document, with the outcome of its live file when live fields changed. */
export type SavedSiteFields = SiteFields & { live?: Awaited<ReturnType<typeof publishLiveSiteFields>> };

async function write(ctx: SiteFieldsCtx, doc: SiteFields, existing: SiteFields, options: SiteFieldsSaveOptions): Promise<SavedSiteFields> {
  // Keep what was there as a revision, so every save can be undone.
  if (existing.updated_at || existing.groups.length || Object.keys(existing.values).length) {
    await snapshotRevision({
      orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'site_fields', resourceIds: ['default'],
      doc: existing as unknown as Record<string, unknown>, createdBy: options.updatedBy, ...(options.note ? { note: options.note } : {}),
    });
  }
  try { await vstore.writeSiteFields(ctx.orgId, ctx.siteId, ctx.versionId, doc, existing.updated_at ?? null); }
  catch (error) {
    if (error instanceof SiteFieldsWriteConflict) throw new SiteFieldsSaveError(error.message, 409);
    throw error;
  }
  const live = await publishLiveSiteFields(ctx, doc, existing).catch((error) => {
    console.warn(`[site-fields] site ${ctx.siteId}: live fields not published`, error instanceof Error ? error.message : error);
    return { published: false as const, code: 'write_failed' as const, reason: 'The live fields file could not be written; the values show at the next publication.' };
  });
  return live ? { ...doc, live } : doc;
}

export function readSiteFields(ctx: SiteFieldsCtx): Promise<SiteFields> {
  return vstore.siteFields(ctx.orgId, ctx.siteId, ctx.versionId);
}

/**
 * Replaces the definitions. A value whose field is gone, or that no longer
 * fits its field (a text field turned into a number), is dropped and listed
 * in `dropped`. Renaming a field is a removal plus an addition.
 */
export async function defineSiteFields(
  ctx: SiteFieldsCtx, input: unknown, options: SiteFieldsSaveOptions,
): Promise<{ siteFields: SavedSiteFields; dropped: string[] }> {
  if (options.permission !== 'admin' && !options.design) throw new SiteFieldsSaveError('Defining site fields needs design permission on the site (an administrator or builder)', 403);
  const { groups, errors } = validateSiteFieldGroups(input);
  if (errors.length) throw new SiteFieldsSaveError(`The site fields are not valid: ${describe(errors)}`, 400, errors);
  const existing = await readSiteFields(ctx);
  checkExpected(existing, options.expectedUpdatedAt);
  const names = new Set(groups.flatMap((group) => group.fields.map((field) => field.name)));
  const kept = Object.fromEntries(Object.entries(existing.values).filter(([name]) => names.has(name)));
  const { values } = validateSiteFieldValues(groups, kept);
  const dropped = Object.keys(existing.values).filter((name) => !(name in values)).sort();
  const siteFields: SiteFields = { groups, values, updated_at: nextStamp(existing) };
  return { siteFields: await write(ctx, siteFields, existing, options), dropped };
}

/**
 * Merges values into the saved ones; `null` removes a value. Only the
 * patched fields are checked as required, so a settings page can be saved
 * while another one is still unfilled (the launch check lists those).
 */
export async function updateSiteFieldValues(
  ctx: SiteFieldsCtx, patch: unknown, options: SiteFieldsSaveOptions,
): Promise<SavedSiteFields> {
  if (RANK[options.permission] < RANK.write) throw new SiteFieldsSaveError('Changing site field values needs write permission on the site', 403);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new SiteFieldsSaveError('values is an object of field names and values', 400, [{ path: 'values', message: 'values is an object' }]);
  const existing = await readSiteFields(ctx);
  checkExpected(existing, options.expectedUpdatedAt);
  const changes = patch as Record<string, unknown>;
  const unknown: SiteFieldError[] = [];
  const adminOnly: string[] = [];
  for (const name of Object.keys(changes)) {
    const group = siteFieldGroupOf(existing.groups, name);
    if (!group) unknown.push({ path: name, message: `No site field is called ${name}` });
    else if (group.access === 'admin' && options.permission !== 'admin') adminOnly.push(name);
  }
  if (unknown.length) throw new SiteFieldsSaveError(`The values are not valid: ${describe(unknown)}`, 400, unknown);
  if (adminOnly.length) throw new SiteFieldsSaveError(`Only a site administrator can change ${adminOnly.join(', ')}`, 403);
  const merged: Record<string, unknown> = { ...existing.values };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  const result = validateSiteFieldValues(existing.groups, merged);
  const errors = result.errors.filter((error) => rootName(error.path) in changes);
  if (errors.length) throw new SiteFieldsSaveError(`The values are not valid: ${describe(errors)}`, 400, errors);
  // Untouched values are kept as they were, valid by construction.
  const values: Record<string, unknown> = {};
  for (const name of Object.keys(merged)) {
    if (name in changes) { if (name in result.values) values[name] = result.values[name]; }
    else values[name] = existing.values[name];
  }
  const siteFields: SiteFields = { groups: existing.groups, values, updated_at: nextStamp(existing) };
  return write(ctx, siteFields, existing, options);
}

/** Restores a revision's definitions and values (admin, since definitions change). */
export async function restoreSiteFieldsRevision(
  ctx: SiteFieldsCtx, doc: Partial<SiteFields>, revId: string, options: Omit<SiteFieldsSaveOptions, 'note' | 'expectedUpdatedAt'>,
): Promise<SavedSiteFields> {
  if (options.permission !== 'admin' && !options.design) throw new SiteFieldsSaveError('Restoring site fields needs design permission on the site (an administrator or builder)', 403);
  const { groups, errors } = validateSiteFieldGroups(doc.groups ?? []);
  if (errors.length) throw new SiteFieldsSaveError(`The revision is not valid: ${describe(errors)}`, 400, errors);
  const { values } = validateSiteFieldValues(groups, doc.values ?? {});
  const existing = await readSiteFields(ctx);
  const siteFields: SiteFields = { groups, values, updated_at: nextStamp(existing) };
  return write(ctx, siteFields, existing, { ...options, note: `Replaced by restore of ${revId}` });
}

/** The groups whose values a caller with `permission` may change. */
export function editableGroups(groups: SiteFieldGroup[], permission: SharePermission): string[] {
  return groups.filter((group) => permission === 'admin' || (RANK[permission] >= RANK.write && group.access !== 'admin')).map((group) => group.id);
}

/** Every field with `required` set and no value, with its settings page. */
export function missingRequiredSiteFields(siteFields: SiteFields): Array<{ group: SiteFieldGroup; name: string; label: string }> {
  const missing: Array<{ group: SiteFieldGroup; name: string; label: string }> = [];
  for (const group of siteFields.groups) for (const field of group.fields) {
    const value = siteFields.values[field.name];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) missing.push({ group, name: field.name, label: field.label });
  }
  return missing;
}

/** The JSON a route answers a refused save with: `{ error, errors? }`. */
export function siteFieldsFailureBody(error: unknown): { status: number; body: { error: string; errors?: SiteFieldError[] } } | null {
  if (!(error instanceof SiteFieldsSaveError)) return null;
  return { status: error.status, body: { error: error.message, ...(error.errors ? { errors: error.errors } : {}) } };
}

/** What a read returns: the document plus the settings pages this caller may fill in. */
export function siteFieldsResponse(siteFields: SavedSiteFields, permission: SharePermission): Omit<SiteFields, 'updated_at'> & { updated_at: string | null; editable_groups: string[]; live?: SavedSiteFields['live'] } {
  return { groups: siteFields.groups, values: siteFields.values, updated_at: siteFields.updated_at ?? null, editable_groups: editableGroups(siteFields.groups, permission),
    ...(siteFields.live ? { live: siteFields.live } : {}) };
}
