import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { answerRevision, submitOwnerProposal, readOwnerProposal, decideOwnerProposal, proposalPath, reviewSettingsPath, ownerReviewGroups } from '../../lib/owner-proposals';
import { decryptSecret } from '../../lib/secret-crypto';
import { vstore } from '../../lib/version-store';
const scope = { orgId: 'review-test', siteId: 'synthetic', versionId: 'main' };
const identity = { installationId: 'trusted-app', subjectId: 'a'.repeat(64) };
const pagePath = paths.page(scope.orgId, scope.siteId, 'company');
const rid = (suffix: string) => `request-0000000000-${suffix}`;
async function setup() {
  makeTmpFixtures(); await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'synthetic-test-only-secret-not-a-credential';
  const store = getStore();
  await store.setDoc(paths.contentType(scope.orgId, scope.siteId, 'company'), { id: 'company', name: 'company', fields: [
    { name: 'online', type: 'boolean', label: 'Online sales?', writable_by: ['owner', 'portal', 'agent', 'import'] },
    { name: 'phone', type: 'text', label: 'Phone', writable_by: ['owner', 'portal', 'agent', 'import'] },
  ] });
  await store.setDoc(pagePath, { title: 'Synthetic Company', content_type: 'company', status: 'published', fields: { online: null, phone: 'Old' } });
  await store.setDoc(reviewSettingsPath(scope), { recipient: 'reviewer@example.test', link_ttl_hours: 24, enabled: true });
  const page = await store.getDoc<any>(pagePath);
  const submit = (changes = { online: false } as Record<string, unknown>, request_id = rid('submission')) => submitOwnerProposal(scope, 'company', identity, { changes, base_revision: answerRevision(page), request_id });
  const result = await submit();
  const proposal = await readOwnerProposal(scope, result.proposal_id);
  return { store, page, submit, id: result.proposal_id, token: decryptSecret(proposal.review.encrypted_token) };
}
describe('pending owner proposals', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('keeps accepted Page and publication reads unchanged until explicit approval', async () => {
    const ctx = await setup();
    expect(await ctx.store.getDoc<any>(pagePath)).toEqual(ctx.page);
    expect((await vstore.pages(scope.orgId, scope.siteId, 'main'))[0].fields?.online).toBeNull();
    await readOwnerProposal(scope, ctx.id, ctx.token);
    await readOwnerProposal(scope, ctx.id, ctx.token);
    expect((await readOwnerProposal(scope, ctx.id)).status).toBe('pending');
    expect(await ctx.store.getDoc<any>(pagePath)).toEqual(ctx.page);
  });
  it('deduplicates submissions without minting additional proposals or changing original values', async () => {
    const ctx = await setup();
    expect((await ctx.submit()).proposal_id).toBe(ctx.id);
    await expect(ctx.submit({ online: true })).rejects.toThrow('already used');
  });
  it('approves false and prevents a later import or forged provenance from overwriting it', async () => {
    const ctx = await setup();
    await decideOwnerProposal(scope, ctx.id, { token: ctx.token }, { action: 'approve', request_id: rid('approve') });
    const page = await ctx.store.getDoc<any>(pagePath);
    expect(page?.fields.online).toBe(false); expect(page?._provenance.online.source).toBe('owner');
    await expect(vstore.writePage(scope.orgId, scope.siteId, 'main', 'company', { fields: { online: true }, _provenance: {} }, { actor: 'import', actorId: 'import-test' })).rejects.toThrow('higher-precedence');
    await vstore.writePage(scope.orgId, scope.siteId, 'main', 'company', { fields: { phone: 'New' } }, { actor: 'import', actorId: 'import-test' });
    expect((await ctx.store.getDoc<any>(pagePath))?.fields).toEqual({ online: false, phone: 'New' });
  });
  it('records reviewer changes separately without falsely attributing them to the owner', async () => {
    const ctx = await setup();
    await decideOwnerProposal(scope, ctx.id, { token: ctx.token }, { action: 'approve', request_id: rid('adjust'), adjustments: { online: true } });
    const proposal = await readOwnerProposal(scope, ctx.id);
    expect(proposal.changes).toEqual({ online: false }); expect(proposal.decision?.adjustments).toEqual({ online: true });
    const page = await ctx.store.getDoc<any>(pagePath);
    expect(page?.fields.online).toBe(true); expect(page?._provenance.online.source).toBe('portal');
  });
  it('allows only the first concurrent decision and idempotent replay of that same action', async () => {
    const ctx = await setup();
    const inputs = [{ action: 'approve' as const, request_id: rid('a') }, { action: 'reject' as const, request_id: rid('r') }];
    const results = await Promise.allSettled(inputs.map(input => decideOwnerProposal(scope, ctx.id, { token: ctx.token }, input)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    await expect(decideOwnerProposal(scope, ctx.id, { token: ctx.token }, inputs[winner])).resolves.toMatchObject({ status: winner === 0 ? 'approved' : 'rejected' });
    expect((await ctx.store.getDoc<any>(pagePath))?.fields.online).toBe(winner === 0 ? false : null);
  });
  it('rejects stale accepted revisions and preserves newer edits', async () => {
    const ctx = await setup(); await ctx.store.updateDoc(pagePath, { fields: { online: true, phone: 'Old' } });
    await expect(decideOwnerProposal(scope, ctx.id, { token: ctx.token }, { action: 'approve', request_id: rid('stale') })).rejects.toThrow('changed');
    expect((await readOwnerProposal(scope, ctx.id)).status).toBe('pending');
    expect((await ctx.store.getDoc<any>(pagePath))?.fields.online).toBe(true);
  });
  it('rejects expired, revoked, wrong-token and wrong-version links', async () => {
    const ctx = await setup();
    await expect(readOwnerProposal(scope, ctx.id, 'b'.repeat(43))).rejects.toThrow('expired or was revoked');
    await expect(readOwnerProposal({ ...scope, versionId: 'other' }, ctx.id, ctx.token)).rejects.toThrow('unavailable');
    const proposal = await readOwnerProposal(scope, ctx.id);
    await ctx.store.updateDoc(proposalPath(scope, ctx.id), { review: { ...proposal.review, expires_at: 1 } });
    await expect(readOwnerProposal(scope, ctx.id, ctx.token)).rejects.toThrow('expired');
    await ctx.store.updateDoc(proposalPath(scope, ctx.id), { review: { ...proposal.review, revoked_at: new Date().toISOString() } });
    await expect(readOwnerProposal(scope, ctx.id, ctx.token)).rejects.toThrow('revoked');
  });
  it('guards schema and inherited Page changes at the commit boundary', async () => {
    const ctx = await setup();
    const compare = ctx.store.compareAndReplaceDoc.bind(ctx.store);
    vi.spyOn(ctx.store, 'compareAndReplaceDoc').mockImplementationOnce(async (path, expected, next, effects) => {
      await ctx.store.updateDoc(paths.contentType(scope.orgId, scope.siteId, 'company'), { name: 'Changed while deciding' });
      return compare(path, expected, next, effects);
    });
    await expect(decideOwnerProposal(scope, ctx.id, { token: ctx.token }, { action: 'approve', request_id: rid('schema-race') })).rejects.toThrow('changed during review');
    expect((await ctx.store.getDoc<any>(pagePath))?.fields.online).toBeNull();
    expect((await readOwnerProposal(scope, ctx.id)).status).toBe('pending');
  });
  it('isolates a branch decision from main and rejects a changed branch base', async () => {
    const ctx = await setup();
    const branch = { ...scope, versionId: 'draft-branch' };
    await ctx.store.setDoc(paths.version(scope.orgId, scope.siteId, branch.versionId), { kind: 'branch', base_version_id: 'main' });
    const proposal = await submitOwnerProposal(branch, 'company', identity, { changes: { online: true }, base_revision: answerRevision(ctx.page), request_id: rid('branch') });
    const compare = ctx.store.compareAndReplaceDoc.bind(ctx.store);
    vi.spyOn(ctx.store, 'compareAndReplaceDoc').mockImplementationOnce(async (path, expected, next, effects) => {
      await ctx.store.updateDoc(paths.version(scope.orgId, scope.siteId, branch.versionId), { base_version_id: 'different-base' });
      return compare(path, expected, next, effects);
    });
    await expect(decideOwnerProposal(branch, proposal.proposal_id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('base-race') })).rejects.toThrow('changed during review');
    expect((await ctx.store.getDoc<any>(pagePath))?.fields.online).toBeNull();
    expect(await ctx.store.getDoc(paths.page(scope.orgId, scope.siteId, 'company', branch.versionId))).toBeNull();
  });

});

describe('what a rejected proposal tells the caller', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('names which requirement is missing, and which was never the caller to send', async () => {
    // These were reported together. An integrator saw that something was
    // missing and could not tell which — including guessing at a subject they
    // could never have supplied, because the installation derives it from the
    // verified owner session rather than accepting one from the request.
    const { page } = await setup();
    const base = answerRevision(page);

    const tooShort = await submitOwnerProposal(scope, 'company', identity,
      { changes: { online: false }, base_revision: base, request_id: 'short' }).catch((e) => e);
    expect(tooShort.message).toMatch(/request_id must contain 16-100/);
    // And it says what the value is for, because choosing it wrongly is silent:
    // the proposal is derived from it, so a replay updates rather than duplicates.
    expect(tooShort.message).toMatch(/replaying the same value/);

    const noSubject = await submitOwnerProposal(scope, 'company', { ...identity, subjectId: '' },
      { changes: { online: false }, base_revision: base, request_id: rid('valid') }).catch((e) => e);
    expect(noSubject.message).toMatch(/not sent by the caller/);
    expect(noSubject.message).not.toMatch(/request_id must contain/);
  });
});


describe('incremental owner review groups', () => {
  it('approves separate saved steps without completing the form and preserves accepted imports protection', async () => {
    const ctx = await setup();
    const second = await ctx.submit({ phone: 'New' }, rid('second-step'));
    await decideOwnerProposal(scope, ctx.id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('approve-first') });
    await decideOwnerProposal(scope, second.proposal_id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('approve-second') });
    expect((await ctx.store.getDoc<any>(pagePath)).fields).toEqual({ online: false, phone: 'New' });
    await expect(vstore.writePage(scope.orgId, scope.siteId, 'main', 'company', { fields: { phone: 'Import overwrite' } }, { actor: 'import', actorId: 'importer' })).rejects.toThrow();
  });
  it('replaces only the same subject and group, keeps retries idempotent and cancels undone answers', async () => {
    const ctx = await setup();
    const send = (changes: Record<string, unknown>, request_id: string, group_revision: string | null) => submitOwnerProposal(scope, 'company', identity, { changes, request_id, group_id: 'contact', group_revision, base_revision: answerRevision(ctx.page) });
    const first = await send({ phone: 'First' }, rid('group-first'), null);
    const next = await send({ phone: 'Second' }, rid('group-next'), first.proposal_id);
    expect((await readOwnerProposal(scope, first.proposal_id)).status).toBe('revoked');
    expect(await send({ phone: 'Second' }, rid('group-next'), first.proposal_id)).toEqual(next);
    const groups = await ownerReviewGroups(scope, 'company', identity);
    expect(groups.contact).toMatchObject({ status: 'pending', changes: { phone: 'Second' } });
    expect(await ownerReviewGroups(scope, 'company', { ...identity, subjectId: 'b'.repeat(64) })).toEqual({});
    expect(await ownerReviewGroups(scope, 'company', { ...identity, installationId: 'other' })).toEqual({});
    await expect(send({ phone: 'Stale' }, rid('group-stale'), first.proposal_id)).rejects.toThrow('saved elsewhere');
    const undo = await send({ phone: 'Old' }, rid('group-undo'), next.proposal_id);
    expect(undo.status).toBe('revoked');
    expect((await ownerReviewGroups(scope, 'company', identity)).contact.changes).toEqual({});
    expect((await ctx.store.getDoc<any>(pagePath)).fields.phone).toBe('Old');
  });
  it('resumes from accepted values instead of replaying pending snapshots', async () => {
    const ctx = await setup();
    const first = await submitOwnerProposal(scope, 'company', identity, { changes: { phone: 'Accepted' }, base_revision: answerRevision(ctx.page), request_id: rid('resume'), group_id: 'contact', group_revision: null });
    await decideOwnerProposal(scope, first.proposal_id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('accept-resume') });
    expect((await ownerReviewGroups(scope, 'company', identity)).contact).toMatchObject({ status: 'approved', changes: {} });
    const page = await ctx.store.getDoc<any>(pagePath);
    await submitOwnerProposal(scope, 'company', identity, { changes: { phone: 'Updated again' }, base_revision: answerRevision(page), request_id: rid('resume-again'), group_id: 'contact', group_revision: first.proposal_id });
    expect((await ctx.store.getDoc<any>(pagePath)).fields.phone).toBe('Accepted');
  });
  it('does not apply a pending snapshot over an independently edited answer', async () => {
    const ctx = await setup();
    const first = await submitOwnerProposal(scope, 'company', identity, { changes: { phone: 'Pending' }, base_revision: answerRevision(ctx.page), request_id: rid('conflict'), group_id: 'contact', group_revision: null });
    await ctx.store.updateDoc(pagePath, { fields: { online: null, phone: 'Editor correction' } });
    expect((await ownerReviewGroups(scope, 'company', identity)).contact).toMatchObject({ status: 'conflict', changes: {} });
    await expect(decideOwnerProposal(scope, first.proposal_id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('conflicted-approve') })).rejects.toThrow('changed');
  });
  it('serializes competing saves to the same group', async () => {
    const ctx = await setup();
    const results = await Promise.allSettled(['one','two'].map(name => submitOwnerProposal(scope, 'company', identity, { changes: { phone: name }, base_revision: answerRevision(ctx.page), request_id: rid(name), group_id: 'contact', group_revision: null })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
});


it('reviews saved support, cleared contact and renamed program coverage independently', async () => {
  const ctx = await setup();
  const typePath = paths.contentType(scope.orgId, scope.siteId, 'company');
  const type = await ctx.store.getDoc<any>(typePath);
  await ctx.store.updateDoc(typePath, { fields: [...type.fields, { name: 'programs', type: 'array', item_key: 'id', writable_by: ['owner', 'portal', 'agent', 'import'], fields: [
    { name: 'id', type: 'text', writable_by: ['portal', 'agent'] }, { name: 'name', type: 'text' }, { name: 'coverage', type: 'text' },
  ] }] });
  await ctx.store.updateDoc(pagePath, { fields: { online: true, phone: 'Old', programs: [{ id: 'stable-id', name: 'Original', coverage: 'National' }] } });
  const original = await ctx.store.getDoc<any>(pagePath);
  const changes = [{ online: false }, { phone: null }, { programs: [{ id: 'stable-id', name: 'Renamed', coverage: 'Regional' }] }];
  const proposals = [];
  for (const [index, patch] of changes.entries()) proposals.push(await submitOwnerProposal(scope, 'company', identity, { changes: patch,
    request_id: rid('scenario-' + index), group_id: 'step-' + index, group_revision: null, base_revision: answerRevision(original) }));
  expect((await vstore.pages(scope.orgId, scope.siteId, 'main'))[0].fields).toEqual(original.fields);
  // No finalization, questionnaire or fourth step exists in this acceptance path.
  for (const [index, proposal] of proposals.entries()) await decideOwnerProposal(scope, proposal.proposal_id, { adminId: 'reviewer' }, { action: 'approve', request_id: rid('accept-' + index) });
  const page = (await vstore.pages(scope.orgId, scope.siteId, 'main'))[0];
  expect(page.fields).toEqual({ online: false, phone: null, programs: [{ id: 'stable-id', name: 'Renamed', coverage: 'Regional' }] });
  for (const group of Object.values(await ownerReviewGroups(scope, 'company', identity))) expect(group.changes).toEqual({});
  await expect(vstore.writePage(scope.orgId, scope.siteId, 'main', 'company', { fields: original.fields }, { actor: 'import', actorId: 'later-import' })).rejects.toThrow();
});

it.each(['__proto__', 'prototype', 'constructor'])('rejects reserved group %s', async group_id => {
  const ctx = await setup();
  await expect(submitOwnerProposal(scope, 'company', identity, { changes: { phone: 'New' }, base_revision: answerRevision(ctx.page), request_id: rid('reserved'), group_id, group_revision: null })).rejects.toThrow('Invalid review group');
});
