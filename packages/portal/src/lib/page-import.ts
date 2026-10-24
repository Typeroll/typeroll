import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONTENT_TYPE, contentPagePath, paths, type FieldDefinition, type Page } from '@typeroll/shared';
import { getStore } from './datastore';
import { pageWriteSnapshot, contentTypeWriteSnapshot } from './version-store';
import { applyFieldAuthority, conflictResponse, readProvenance } from './field-authority';
import { answerRevision } from './owner-proposals';
import { validatePageFields } from './page-fields';
import { sanitizeBody } from './sanitize';
import { markSiteDirty } from './auto-deploy';

type Scope = { orgId: string; siteId: string; versionId: string };
export class PageImportError extends Error {
  constructor(message: string, readonly status = 400, readonly details?: unknown) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const revisionFor = (scope: Scope, page: Page, type: unknown, working: unknown) =>
  answerRevision({ orgId: scope.orgId, siteId: scope.siteId, versionId: scope.versionId, page, type, working });

/** Paths use the same escaped schema-leaf/keyed-item notation as provenance. */
function segments(path: unknown): string[] {
  if (typeof path !== 'string' || !path || path.length > 1000) throw new PageImportError('Expected a schema leaf path up to 1000 characters');
  const parts = path.split('/');
  if (parts.length > 20 || parts.some(part => !part || /~(?![01])/.test(part))) throw new PageImportError(`Invalid field path: ${path}`);
  const decoded = parts.map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (decoded.some(part => forbidden.has(part))) throw new PageImportError('Unsafe field path');
  return decoded;
}

/** Resolve a leaf without permitting array replacement, implicit item creation or identity changes. */
function leaf(fields: FieldDefinition[], values: Record<string, unknown>, path: string, createObjects = false) {
  const parts = segments(path);
  let schema = fields, container = values;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const field = schema.find(item => item.name === name);
    if (!field) throw new PageImportError(`Unknown field path: ${path}`);
    if (i === parts.length - 1) {
      if (field.type === 'object' || (field.fields && ['array', 'list'].includes(field.type)))
        throw new PageImportError(`Address an individual leaf, not a compound field: ${path}`);
      return { container, name, field };
    }
    if (field.type === 'object' && field.fields) {
      if (container[name] == null) {
        if (createObjects) container[name] = {};
        else { container = {}; schema = field.fields; continue; }
      }
      if (!object(container[name])) throw new PageImportError(`Expected an object at ${name}`);
      container = container[name]; schema = field.fields;
    } else if (field.fields && field.item_key && ['array', 'list'].includes(field.type)) {
      const selector = parts[++i];
      if (!selector?.startsWith('@') || selector.length === 1 || i === parts.length - 1)
        throw new PageImportError(`Use @<stable item id> followed by a leaf: ${path}`);
      const rows = container[name];
      if (!Array.isArray(rows)) throw new PageImportError(`No keyed items at ${name}`);
      const matches = rows.filter(row => object(row) && row[field.item_key!] === selector.slice(1));
      if (matches.length !== 1) throw new PageImportError(`Expected one existing keyed item: ${path}`);
      if (parts[i + 1] === field.item_key) throw new PageImportError('Import cannot change a stable item identity');
      container = matches[0]; schema = field.fields;
    } else throw new PageImportError(`Not a structured field: ${path}`);
  }
  throw new PageImportError('Expected a leaf');
}

async function snapshot(scope: Scope, pageId: string) {
  const saved = await pageWriteSnapshot(scope.orgId, scope.siteId, scope.versionId, pageId);
  if (!saved.page) throw new PageImportError('Page not found', 404);
  const schema = await contentTypeWriteSnapshot(scope.orgId, scope.siteId, scope.versionId, saved.page.content_type ?? 'page');
  const type = schema.type ?? ((saved.page.content_type ?? 'page') === 'page' ? DEFAULT_CONTENT_TYPE : null);
  if (!type) throw new PageImportError('Content type not found', 409);
  const workingPath = paths.workingCopy(scope.orgId, scope.siteId, `page--${pageId}`, scope.versionId);
  const working = await getStore().getDoc(workingPath);
  const revision = revisionFor(scope, saved.page, type, working);
  return { saved, schema, type, workingPath, working, revision };
}

export async function readPageAuthority(scope: Scope, pageId: string, requested: unknown) {
  if (!Array.isArray(requested) || !requested.length || requested.length > 100 || requested.some(path => typeof path !== 'string'))
    throw new PageImportError('paths must contain 1–100 schema leaf paths');
  const state = await snapshot(scope, pageId);
  const provenance = readProvenance(state.saved.page!);
  const fields = requested.map((path: string) => {
    leaf(state.type.fields, state.saved.page!.fields ?? {}, path);
    let effective = path;
    while (effective && !Object.hasOwn(provenance, effective)) effective = effective.includes('/') ? effective.slice(0, effective.lastIndexOf('/')) : '';
    return { path, source: effective ? provenance[effective].source : null,
      attribution: !effective ? 'unattributed' : effective === path ? 'explicit' : 'inherited',
      effective_path: effective || null };
  });
  // No values, actor IDs, evidence URLs, private metadata or working-copy content.
  return { page_id: pageId, revision: state.revision, has_unsaved_changes: !!state.working, fields };
}

export async function importPageFields(scope: Scope, pageId: string, input: unknown, actorId: string) {
  if (!object(input) || Object.keys(input).some(key => !['base_revision', 'changes', 'import_run_id', 'source_url'].includes(key)))
    throw new PageImportError('Expected base_revision, changes and optional import_run_id/source_url');
  if (typeof input.base_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.base_revision)) throw new PageImportError('A current authority base_revision is required');
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100) throw new PageImportError('changes must contain 1–100 leaf changes');
  if (input.import_run_id !== undefined && (typeof input.import_run_id !== 'string' || !input.import_run_id.trim() || input.import_run_id.length > 200)) throw new PageImportError('Invalid import_run_id');
  if (input.source_url !== undefined) {
    try { if (typeof input.source_url !== 'string' || input.source_url.length > 2000 || !['https:', 'http:'].includes(new URL(input.source_url).protocol)) throw new Error(); }
    catch { throw new PageImportError('source_url must be an HTTP(S) URL'); }
  }
  const state = await snapshot(scope, pageId);
  if (state.revision !== input.base_revision) throw new PageImportError('Page, schema or draft changed. Read authority again before importing.', 409);
  if (state.working) throw new PageImportError('Save or discard the existing working copy before importing.', 409);
  const page = state.saved.page!;
  const nextFields = structuredClone(page.fields ?? {});
  const seen = new Set<string>();
  const roots = new Set<string>();
  for (const change of input.changes) {
    if (!object(change) || Object.keys(change).some(key => !['path', 'value'].includes(key)) || !Object.hasOwn(change, 'value') || change.value === undefined)
      throw new PageImportError('Each change must contain only path and value');
    const path = segments(change.path).map(escape).join('/');
    if (seen.has(path)) throw new PageImportError(`Duplicate field path: ${path}`);
    seen.add(path);
    roots.add(segments(path)[0]);
    const target = leaf(state.type.fields, nextFields, path, true);
    target.container[target.name] = target.field.type === 'richtext' && typeof change.value === 'string' ? sanitizeBody(change.value) : change.value;
    // Validate every new leaf against today's schema, not untouched legacy
    // storage. Retiring an unrelated schema field must not block future imports.
    const invalid = validatePageFields({ ...state.type, fields: [target.field] }, { [target.name]: target.container[target.name] });
    if (invalid) throw new PageImportError(`${path}: ${invalid}`);
  }
  const incoming = Object.fromEntries([...roots].map(name => [name, nextFields[name]]));
  const authority = applyFieldAuthority({ fields: state.type.fields, incoming, existing: page,
    actor: 'import', actorId, sourceUrl: input.source_url as string | undefined, importRunId: input.import_run_id as string | undefined });
  if (authority.rejected.length) throw new PageImportError(conflictResponse(authority.rejected).error, 409, { rejected_fields: authority.rejected });
  const next: Page = { ...page, fields: nextFields, _provenance: authority.provenance };
  if (contentPagePath(page, state.type) !== contentPagePath(next, state.type))
    throw new PageImportError('Import would change the Page URL. Use the normal route-editing flow.', 409);
  if (isDeepStrictEqual(page.fields ?? {}, nextFields)) return { page_id: pageId, changed: false, revision: state.revision };
  next.date_updated = new Date().toISOString();
  const effects = [...state.saved.guards.filter(guard => guard.path !== state.saved.destination), ...state.schema.guards,
    { path: state.workingPath, expected: null, data: {}, guardOnly: true },
    { path: `${state.saved.destination}/answer_history/${randomUUID()}`, expected: null, replace: true, data: {
      actor: 'import', actor_id: actorId, at: next.date_updated, paths: [...seen],
      before: page.fields ?? {}, after: nextFields, provenance: authority.provenance,
    } }];
  if (!await getStore().compareAndReplaceDoc(state.saved.destination, state.saved.physical, next, effects))
    throw new PageImportError('Page, schema or draft changed during import. Read authority again.', 409);
  await markSiteDirty(scope.orgId, scope.siteId, scope.versionId);
  return { page_id: pageId, changed: true, revision: revisionFor(scope, next, state.type, null) };
}
