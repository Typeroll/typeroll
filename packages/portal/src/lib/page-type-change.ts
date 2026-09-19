import { isDeepStrictEqual } from 'node:util';
import { pageAuthorityFields, paths, type Page } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore, pageWriteSnapshot, contentTypeWriteSnapshot } from './version-store';
import { pageAddress, pageContentType, validatePageFields, validatePagePresentation } from './page-fields';
import { readWorkingCopy, WorkingCopyError, type WcCtx } from './working-copy';
import { applyFieldAuthority, conflictResponse, type WriteActor } from './field-authority';
import { snapshotRevision } from './revisions';
import { markSiteDirty } from './auto-deploy';

/** A deliberate structural change, shared by UI, API and MCP. Body, identity,
 * publication state and existing public path survive changing the field schema. */
export async function changePageContentType(ctx: WcCtx, pageId: string, input: { content_type?: unknown; fields?: unknown }, actor: WriteActor, actorId: string): Promise<Page> {
  if (typeof input.content_type !== 'string' || !input.content_type) throw new WorkingCopyError('content_type is required', 400);
  const store = getStore();
  const documentPath = paths.page(ctx.orgId, ctx.siteId, pageId, ctx.versionId);
  const snapshot = await pageWriteSnapshot(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  const { physical: physicalPage, page } = snapshot;
  if (!page) throw new WorkingCopyError('Page not found', 404);
  const currentType = await pageContentType(ctx, page);
  const nextType = await pageContentType(ctx, { content_type: input.content_type });
  if (!currentType || !nextType) throw new WorkingCopyError('Content type not found', 404);
  if (currentType.id === nextType.id) return page;
  const presentationError = await validatePagePresentation(ctx, nextType, page);
  if (presentationError) throw new WorkingCopyError(presentationError, 409);
  const draft = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  if (draft && Object.keys(draft.fields).length) throw new WorkingCopyError('Save or discard this page’s unsaved changes before changing its content type.', 409);
  const fields = input.fields === undefined ? page.fields ?? {} : input.fields;
  const error = validatePageFields(nextType, fields, true);
  if (error) throw new WorkingCopyError(`${error}. Supply the complete fields object for the new content type.`, 400);
  const nextFields = { ...Object.fromEntries(nextType.fields.filter(field => field.default !== undefined).map(field => [field.name, field.default])), ...fields as Record<string, unknown> };
  // Changing type must not become a way to bypass ownership of existing fields.
  const changes = Object.fromEntries([...new Set([...Object.keys(page.fields ?? {}), ...Object.keys(nextFields)])].map(name => [name, nextFields[name] ?? null]));
  let provenance = page._provenance ?? {};
  const schemaGuards: import('./datastore').ConditionalEffect[] = [];
  for (const type of [currentType, nextType]) {
    const schema = await contentTypeWriteSnapshot(ctx.orgId, ctx.siteId, ctx.versionId, type.id);
    if (schema.type && !isDeepStrictEqual(schema.type, type)) throw new WorkingCopyError('Content type changed. Reload and try again.', 409);
    schemaGuards.push(...schema.guards);
    const authority = applyFieldAuthority({ fields: pageAuthorityFields(type), incoming: changes, existing: { ...page, ...page.fields }, actor, actorId });
    if (authority.rejected.length) throw new WorkingCopyError(conflictResponse(authority.rejected).error, 409);
    provenance = { ...provenance, ...authority.provenance };
  }
  const path = await pageAddress(ctx, page);
  const next: Page = { ...page, content_type: nextType.id, fields: nextFields, _provenance: provenance, date_updated: new Date().toISOString(), ...(path ? { path } : {}) };
  // An explicit template belongs to the Page. The old type's default was never
  // stored on the Page and is replaced naturally by the new type's default.
  await snapshotRevision({ ...ctx, kind: 'page', resourceIds: [pageId], doc: page as unknown as Record<string, unknown>, createdBy: actorId, note: `Content type: ${currentType.id} → ${nextType.id}` });
  if (!await store.compareAndReplaceDoc(documentPath, physicalPage, next, [
    ...snapshot.guards.filter(guard => guard.path !== documentPath), ...schemaGuards,
    { path: `${documentPath}/answer_history/${crypto.randomUUID()}`, expected: null, replace: true, data: {
      actor, actor_id: actorId, at: next.date_updated, before: page.fields ?? {}, after: nextFields,
      before_type: currentType.id, after_type: nextType.id, provenance,
    } },
  ])) {
    throw new WorkingCopyError('This page changed while its content type was being saved. Reload and try again.', 409);
  }
  await markSiteDirty(ctx.orgId, ctx.siteId);
  return next;
}
