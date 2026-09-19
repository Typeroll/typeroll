import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { paths, pageAuthorityFields, pageContentValues, PAGE_BUILTIN_FIELDS, type Page, type FieldDefinition, type ContentType } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore, pageWriteSnapshot, contentTypeWriteSnapshot } from './version-store';
import { applyFieldAuthority, conflictResponse, writableBy } from './field-authority';
import { validatePageFields } from './page-fields';
import { sanitizeBody } from './sanitize';
import { encryptSecret, isSecretCryptoConfigured } from './secret-crypto';

export interface ProposalScope { orgId: string; siteId: string; versionId: string }
export class ProposalError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface OwnerProposal {
  id: string; page_id: string; title: string; version_id: string; content_type: string;
  installation_id: string; subject_id: string; base_revision: string; schema_revision: string;
  before: Record<string, unknown>; changes: Record<string, unknown>; fingerprint: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked'; created_at: string;
  review: { hash: string; encrypted_token: string; expires_at: number; revoked_at?: string };
  notification: { status: 'pending' | 'sending' | 'accepted' | 'failed'; attempts: number; last_attempt_at?: string; accepted_at?: string; message_id?: string; delivery_status?: string };
  decision?: { action: 'approve' | 'reject'; request_id: string; fingerprint: string; actor_id: string; at: string; adjustments: Record<string, unknown> };
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const answerRevision = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const proposalCollection = (scope: ProposalScope) => `organizations/${scope.orgId}/sites/${scope.siteId}/owner_proposals`;
export const proposalPath = (scope: ProposalScope, id: string) => `${proposalCollection(scope)}/${id}`;
export const reviewSettingsPath = (scope: Pick<ProposalScope, 'orgId' | 'siteId'>) => `organizations/${scope.orgId}/sites/${scope.siteId}/private_settings/owner_review`;
export interface ReviewSettings { recipient: string; link_ttl_hours: number; enabled: boolean }
export function validateReviewSettings(input: unknown): ReviewSettings {
  const value = input as ReviewSettings;
  if (!value || typeof value.enabled !== 'boolean' || typeof value.recipient !== 'string' ||
    !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(value.recipient) ||
    !Number.isInteger(value.link_ttl_hours) || value.link_ttl_hours < 1 || value.link_ttl_hours > 168)
    throw new ProposalError('Enter one reviewer email and a review-link lifetime from 1 to 168 hours.');
  return { recipient: value.recipient, link_ttl_hours: value.link_ttl_hours, enabled: value.enabled };
}
export async function ownerReviewReady(scope: ProposalScope): Promise<boolean> {
  const settings = await getStore().getDoc<ReviewSettings>(reviewSettingsPath(scope));
  if (!settings?.enabled || !isSecretCryptoConfigured()) return false;
  try { validateReviewSettings(settings); return true; } catch { return false; }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function clean(value: unknown, definition: FieldDefinition): unknown {
  if (value == null) return value;
  if (definition.type === 'richtext' && typeof value === 'string') return sanitizeBody(value);
  if (definition.type === 'object' && definition.fields && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clean(child, definition.fields!.find(field => field.name === key)!)]));
  if (['array', 'list'].includes(definition.type) && definition.fields && Array.isArray(value)) return value.map(child => clean(child, { ...definition, type: 'object' }));
  return value;
}
export function checkedPatch(type: ContentType, fields: FieldDefinition[], input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProposalError('Expected a changes object');
  const patch = input as Record<string, unknown>;
  if (Object.keys(patch).some(name => !fields.some(field => field.name === name))) throw new ProposalError('The proposal contains a field that is not owner-writable', 403);
  const invalid = validatePageFields({ ...type, fields }, patch);
  if (invalid) throw new ProposalError(invalid);
  return Object.fromEntries(Object.entries(patch).map(([name, value]) => [name, clean(value, fields.find(field => field.name === name)!)]));
}
function applyToPage(page: Page, update: Record<string, unknown>, provenance: Page['_provenance']): Page {
  return { ...page, ...Object.fromEntries(Object.entries(update).filter(([key]) => PAGE_BUILTIN_FIELDS.has(key))),
    fields: { ...page.fields, ...Object.fromEntries(Object.entries(update).filter(([key]) => !PAGE_BUILTIN_FIELDS.has(key))) },
    _provenance: provenance, date_updated: new Date().toISOString() };
}
export async function ownerFieldDescriptor(scope: ProposalScope, pageId: string) {
  if (scope.versionId !== 'main' && !await getStore().getDoc(paths.version(scope.orgId, scope.siteId, scope.versionId))) throw new ProposalError('Version not found', 404);
  const page = await vstore.page(scope.orgId, scope.siteId, scope.versionId, pageId);
  if (!page?.content_type) throw new ProposalError('Page not found', 404);
  const type = await vstore.contentType(scope.orgId, scope.siteId, scope.versionId, page.content_type);
  if (!type) throw new ProposalError('Content type not found', 404);
  const allowedFields = (definitions: FieldDefinition[], inherited = ['portal', 'agent'] as Array<'portal' | 'agent' | 'owner' | 'app' | 'import'>, identityKey?: string): FieldDefinition[] =>
    definitions.filter(field => field.name === identityKey || (field.writable_by?.length ? field.writable_by : inherited).includes('owner')).map(field => ({ ...field,
      ...(field.fields ? { fields: allowedFields(field.fields, field.writable_by?.length ? field.writable_by : inherited, ['array', 'list'].includes(field.type) ? field.item_key : undefined) } : {}),
    }));
  const fields = allowedFields(pageAuthorityFields(type));
  return { page, type, fields, revision: answerRevision(page) };
}

export function ownerAnswerValue(field: FieldDefinition, value: unknown): unknown {
  if (value == null) return null;
  if (field.type === 'object' && field.fields && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(
    field.fields.filter(child => Object.hasOwn(value, child.name)).map(child => [child.name, ownerAnswerValue(child, (value as Record<string, unknown>)[child.name])]));
  if (['array', 'list'].includes(field.type) && field.fields && Array.isArray(value)) return value.map(item => ownerAnswerValue({ ...field, type: 'object' }, item));
  return value;

}

/** Editing metadata contains no authentication identities or private reference targets. */
export async function ownerEditorFields(scope: ProposalScope, page: Page, fields: FieldDefinition[]) {
  const hasRefs = (items: FieldDefinition[]): boolean => items.some(field => ['page_ref', 'page_ref_list'].includes(field.type) || (field.fields && hasRefs(field.fields)));
  const pages = hasRefs(fields) ? (await vstore.pages(scope.orgId, scope.siteId, scope.versionId)).filter(item => item.status === 'published') : [];
  const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const source = (path: string) => {
    for (let key = path; key; key = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '') {
      const entry = page._provenance?.[key];
      if (entry) return { kind: entry.source, updated_at: entry.updated_at };
    }
    return undefined;
  };
  const describe = (field: FieldDefinition): Record<string, unknown> => ({ ...field,
    ...(field.writable_by?.length && !field.writable_by.includes('owner') ? { read_only: true } : {}),
    ...(field.fields ? { fields: field.fields.map(describe) } : {}),
    ...(['page_ref', 'page_ref_list'].includes(field.type) ? { options: pages.filter(item => !field.ref_content_type || item.content_type === field.ref_content_type).map(item => ({ value: item.id, label: item.title })) } : {}),
  });
  return fields.map(field => {
    const value = ownerAnswerValue(field, pageContentValues(page)[field.name]);
    const sources: Record<string, { kind: string; updated_at: string }> = {};
    const visit = (definition: FieldDefinition, current: unknown, path: string) => {
      const provenance = source(path); if (provenance) sources[path] = provenance;
      if (definition.fields && current && typeof current === 'object') {
        if (Array.isArray(current) && definition.item_key) for (const item of current) {
          const id = item?.[definition.item_key]; if (typeof id === 'string')
            for (const child of definition.fields) visit(child, item[child.name], `${path}/@${escape(id)}/${escape(child.name)}`);
        }
        else if (!Array.isArray(current)) for (const child of definition.fields) visit(child, (current as Record<string, unknown>)[child.name], `${path}/${escape(child.name)}`);
      }
    };
    visit(field, value, field.name);
    return { ...describe(field), name: field.name, value, sources, path: field.name, ...(source(field.name) ? { source: source(field.name) } : {}) };
  });
}

export async function submitOwnerProposal(scope: ProposalScope, pageId: string, identity: { installationId: string; subjectId: string }, input: {
  changes: unknown; base_revision: string; request_id: string;
}) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(input.request_id ?? '') || !/^[a-f0-9]{64}$/.test(identity.subjectId)) throw new ProposalError('A verified subject and request ID are required');
  const store = getStore();
  const settings = await store.getDoc<ReviewSettings>(reviewSettingsPath(scope));
  if (!settings || !await ownerReviewReady(scope)) throw new ProposalError('Owner-change review is not configured for this site', 409);
  const { page, type, fields, revision } = await ownerFieldDescriptor(scope, pageId);
  const changes = checkedPatch(type, fields, input.changes);
  const id = answerRevision([scope, pageId, identity, input.request_id]);
  const path = proposalPath(scope, id);
  const fingerprint = answerRevision({ changes, base_revision: input.base_revision });
  const prior = await store.getDoc<OwnerProposal>(path);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new ProposalError('This request ID was already used for another proposal', 409);
    return { proposal_id: id, status: prior.status };
  }
  if (input.base_revision !== revision) throw new ProposalError('The profile changed. Reload it before submitting.', 409);
  const authority = applyFieldAuthority({ fields, incoming: changes, existing: page, actor: 'owner', actorId: `${identity.installationId}:${identity.subjectId}` });
  if (authority.rejected.length) throw new ProposalError(conflictResponse(authority.rejected).error, 409);
  const values = pageContentValues(page);
  const deliberate = Object.fromEntries(Object.entries(authority.update).filter(([name, value]) => !isDeepStrictEqual(values[name], value)));
  if (!Object.keys(deliberate).length) throw new ProposalError('No changed answers to submit');
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const proposal: OwnerProposal = { id, page_id: pageId, title: page.title, version_id: scope.versionId, content_type: type.id,
    installation_id: identity.installationId, subject_id: identity.subjectId, base_revision: revision, schema_revision: answerRevision(type),
    before: Object.fromEntries(Object.keys(deliberate).map(name => [name, ownerAnswerValue(fields.find(field => field.name === name)!, values[name])])), changes: Object.fromEntries(Object.entries(deliberate).map(([name, value]) => [name, ownerAnswerValue(fields.find(field => field.name === name)!, value)])), fingerprint,
    status: 'pending', created_at: now,
    review: { hash: tokenHash(token), encrypted_token: encryptSecret(token), expires_at: Date.now() + settings.link_ttl_hours * 3_600_000 },
    notification: { status: 'pending', attempts: 0 } };
  if (!(await store.createDocIfMissing(path, proposal))) {
    const winner = await store.getDoc<OwnerProposal>(path);
    if (winner?.fingerprint !== fingerprint) throw new ProposalError('Proposal request conflict', 409);
    return { proposal_id: id, status: winner.status };
  }
  return { proposal_id: id, status: 'pending' as const };
}

export async function readOwnerProposal(scope: ProposalScope, id: string, token?: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ProposalError('Review link unavailable', 404);
  const proposal = await getStore().getDoc<OwnerProposal>(proposalPath(scope, id));
  if (!proposal || proposal.version_id !== scope.versionId) throw new ProposalError('Review link unavailable', 404);
  if (token !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(token) || tokenHash(token) !== proposal.review.hash ||
      proposal.review.revoked_at || proposal.review.expires_at <= Date.now())) throw new ProposalError('This review link has expired or was revoked. Open the review queue in Typeroll.', 401);
  return proposal;
}
export async function decideOwnerProposal(scope: ProposalScope, id: string, auth: { token: string } | { adminId: string }, input: {
  action: 'approve' | 'reject'; request_id: string; adjustments?: Record<string, unknown>;
}) {
  if (!['approve', 'reject'].includes(input.action) || !/^[A-Za-z0-9_-]{16,100}$/.test(input.request_id ?? '')) throw new ProposalError('Choose an explicit review action with a request ID');
  const store = getStore();
  const proposal = await readOwnerProposal(scope, id, 'token' in auth ? auth.token : undefined);
  const actor = 'adminId' in auth ? `admin:${auth.adminId}` : `review-link:${id}`;
  const fingerprint = answerRevision(input);
  if (proposal.status !== 'pending') {
    if (proposal.decision?.request_id === input.request_id && proposal.decision.fingerprint === fingerprint && proposal.decision.actor_id === actor)
      return { proposal_id: id, status: proposal.status };
    throw new ProposalError('This proposal has already been decided or revoked', 409);
  }
  const snapshot = await pageWriteSnapshot(scope.orgId, scope.siteId, scope.versionId, proposal.page_id);
  const page = snapshot.page;
  const { type, fields } = await ownerFieldDescriptor(scope, proposal.page_id);
  if (!page || answerRevision(page) !== proposal.base_revision || answerRevision(type) !== proposal.schema_revision)
    throw new ProposalError('The accepted profile or its fields changed. Review the current version before applying this proposal.', 409);
  const adjustments = input.adjustments ? checkedPatch(type, fields, input.adjustments) : {};
  if (input.action === 'reject' && Object.keys(adjustments).length) throw new ProposalError('A rejection cannot contain edits');
  const schema = await contentTypeWriteSnapshot(scope.orgId, scope.siteId, scope.versionId, proposal.content_type);
  if (!schema.type || answerRevision(schema.type) !== proposal.schema_revision) throw new ProposalError('The field schema changed during review.', 409);
  const effects: import('./datastore').ConditionalEffect[] = [...schema.guards];
  if (input.action === 'approve') {
    const original = applyFieldAuthority({ fields, incoming: proposal.changes, existing: page, actor: 'owner', actorId: `${proposal.installation_id}:${proposal.subject_id}` });
    if (original.rejected.length) throw new ProposalError(conflictResponse(original.rejected).error, 409);
    let next = applyToPage(page, original.update, original.provenance);
    const amended = applyFieldAuthority({ fields, incoming: adjustments, existing: next, actor: 'portal', actorId: actor, overrideReason: `Edited while reviewing proposal ${id}` });
    if (amended.rejected.length) throw new ProposalError(conflictResponse(amended.rejected).error, 409);
    next = applyToPage(next, amended.update, amended.provenance);
    const invalid = validatePageFields(type, next.fields ?? {}, true);
    if (invalid) throw new ProposalError(invalid);
    effects.push({ path: snapshot.destination, expected: snapshot.physical, data: next, replace: true },
      ...snapshot.guards.filter(guard => guard.path !== snapshot.destination),
      { path: `${snapshot.destination}/answer_history/${id}`, expected: null, replace: true, data: {
        proposal_id: id, before: pageContentValues(page), after: pageContentValues(next), provenance: next._provenance ?? {}, actor_id: actor, at: new Date().toISOString(),
      } });
  } else effects.push(...snapshot.guards);
  const next: OwnerProposal = { ...proposal, status: input.action === 'approve' ? 'approved' : 'rejected',
    decision: { action: input.action, request_id: input.request_id, fingerprint, actor_id: actor, at: new Date().toISOString(), adjustments } };
  if (!await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, next, effects)) {
    const winner = await readOwnerProposal(scope, id);
    if (winner.decision?.request_id === input.request_id && winner.decision.fingerprint === fingerprint && winner.decision.actor_id === actor)
      return { proposal_id: id, status: winner.status };
    throw new ProposalError('The profile or proposal changed during review. Reload before deciding.', 409);
  }
  // Acceptance never starts a deployment. A normal publication includes these
  // accepted values; pending proposals are outside the publication content tree.
  return { proposal_id: id, status: next.status };
}
