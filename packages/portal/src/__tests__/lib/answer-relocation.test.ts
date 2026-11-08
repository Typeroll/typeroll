import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, type ContentType } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createApiKey } from '../../lib/api-keys';
import { importPageFields, readPageAuthority } from '../../lib/page-import';
import { relocatePageAnswers } from '../../lib/answer-relocation';
import { vstore } from '../../lib/version-store';
import { answerRevision, decideOwnerProposal, readOwnerProposal, reviewSettingsPath, submitOwnerProposal } from '../../lib/owner-proposals';
import { mergeWorkingCopy } from '../../lib/working-copy';
import { decryptSecret } from '../../lib/secret-crypto';
import { POST as create } from '../../pages/api/v1/sites/[siteId]/pages/index';
import { POST as relocateRoute } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/relocate-answers';

const scope = { orgId: 'relocation-test', siteId: 'test-site', versionId: 'main' };
const writable_by = ['portal', 'owner', 'import'] as const;
const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, label: name, writable_by: [...writable_by], ...extra });
const support = () => field('sales_support', 'object', { fields: [field('training', 'boolean'), field('webshop', 'boolean')] });
const schema = {
  id: 'companies', name: 'companies', route_template: '/companies/{slug}', fields: [
    field('sales_support_answers', 'object', { fields: [field('training', 'boolean'), field('webshop', 'boolean')] }),
    field('sales_method_answers', 'object', { fields: [field('buy_to_sell', 'boolean')] }),
    field('programs', 'array', { item_key: 'program_id', fields: [field('program_id', 'text'), field('name', 'text'),
      field('methods', 'object', { fields: [field('buy_to_sell', 'boolean')] }), support()] }),
  ],
} as ContentType;
const OWNER = { source: 'owner' as const, actor: 'trusted:owner-subject', updated_at: '2026-10-01T10:00:00.000Z', source_url: 'https://private.example/evidence' };
const PORTAL = { source: 'portal' as const, actor: 'editor@private.example', updated_at: '2026-10-02T10:00:00.000Z' };
let token: string;
let pageId: string;
const pagePath = () => paths.page(scope.orgId, scope.siteId, pageId);
const read = async () => (await vstore.page(scope.orgId, scope.siteId, 'main', pageId))!;
const revision = async () => (await readPageAuthority(scope, pageId, ['sales_support_answers/training'])).revision;
const relocate = async (moves: Array<{ from: string; to: string }>, extra: Record<string, unknown> = {}) =>
  relocatePageAnswers(scope, pageId, { base_revision: await revision(), reason: 'Program-scoped support, reviewed mapping', moves, ...extra }, 'api-key:test');
async function seed(fields: Record<string, unknown>, provenance: Record<string, unknown>) {
  const page = await read();
  await getStore().setDoc(pagePath(), { ...page, fields: { ...page.fields, ...fields }, _provenance: provenance });
}
const programs = (one: Record<string, unknown> = {}, two: Record<string, unknown> = {}) => [
  { program_id: 'p1', name: 'Cookie dough', ...one }, { program_id: 'p2', name: 'Candles', ...two },
];

describe('reviewed answer relocation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); makeTmpFixtures(); await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'synthetic-test-only-secret-not-a-credential';
    await getStore().setDoc(paths.site(scope.orgId, scope.siteId), { name: 'Test' });
    await getStore().setDoc(paths.contentType(scope.orgId, scope.siteId, 'companies'), schema);
    ({ token } = await createApiKey({ orgId: scope.orgId, siteId: scope.siteId, name: 'Test', createdBy: 'test@example.test' }));
    const result = await create({ params: { siteId: scope.siteId }, request: new Request(`http://localhost/api/v1/sites/${scope.siteId}/pages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Company A', slug: 'company-a', content_type: 'companies', status: 'published', blocks: [], write_mode: 'import', fields: { programs: programs() } }),
    }), locals: {}, cookies: { get: () => undefined } } as never);
    expect(result.status).toBe(201);
    pageId = (await result.json()).page.id;
  });

  it('moves an owner answer to one program with its source, author, time, evidence and parent protection; the sibling and the source stay', async () => {
    // The owner saved the whole company support group; the leaf is protected through it.
    await seed({ sales_support_answers: { training: true }, programs: programs() }, { sales_support_answers: OWNER });
    const before = await read();
    const dry = await relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }], { dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, changed: true, summary: { relocated: 1 }, moves: [{ outcome: 'relocated', attribution: 'inherited', source: 'owner' }] });
    expect(await read()).toEqual(before);

    const done = await relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }]);
    expect(done).toMatchObject({ dry_run: false, changed: true, summary: { relocated: 1 } });
    // The receipt names paths and kinds of source, never values, actors or evidence.
    expect(JSON.stringify(done)).not.toMatch(/private|owner-subject|evidence/);
    const after = await read();
    expect(after.fields?.sales_support_answers).toEqual({ training: true });
    expect((after.fields?.programs as Array<Record<string, unknown>>)).toEqual([
      { program_id: 'p1', name: 'Cookie dough', sales_support: { training: true } }, { program_id: 'p2', name: 'Candles' },
    ]);
    expect(after._provenance?.['programs/@p1/sales_support/training']).toEqual({ ...OWNER, relocated_from: 'sales_support_answers', relocated_at: expect.any(String) });
    expect(after._provenance?.sales_support_answers).toEqual(OWNER);
    expect(Object.keys(after._provenance ?? {}).some(key => key.startsWith('programs/@p2'))).toBe(false);
    const history = await getStore().listDocs<{ actor: string; reason: string }>(`${pagePath()}/answer_history`);
    expect(history).toEqual([expect.objectContaining({ actor: 'relocation', reason: 'Program-scoped support, reviewed mapping' })]);
  });

  it('then protects the moved answer from a later research import, while the owner can still change Yes to No', async () => {
    await seed({ sales_support_answers: { training: true }, programs: programs() }, { 'sales_support_answers/training': OWNER });
    await relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }]);
    await expect(importPageFields(scope, pageId, { base_revision: await revision(), changes: [{ path: 'programs/@p1/sales_support/training', value: false }] }, 'research'))
      .rejects.toMatchObject({ status: 409 });

    await getStore().setDoc(reviewSettingsPath(scope), { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
    const current = await read();
    const submitted = await submitOwnerProposal(scope, pageId, { installationId: 'trusted', subjectId: 'a'.repeat(64) }, {
      base_revision: answerRevision(current), request_id: 'relocation-owner-0001',
      changes: { programs: programs({ sales_support: { training: false } }) },
    });
    const proposal = await readOwnerProposal(scope, submitted.proposal_id);
    await decideOwnerProposal(scope, submitted.proposal_id, { token: decryptSecret(proposal.review.encrypted_token) }, { action: 'approve', request_id: 'relocation-owner-0002' });
    const answered = await read();
    expect((answered.fields?.programs as Array<Record<string, any>>)[0]!.sales_support.training).toBe(false);
    await expect(importPageFields(scope, pageId, { base_revision: await revision(), changes: [{ path: 'programs/@p1/sales_support/training', value: true }] }, 'research'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('never replaces a protected target, including an explicit clear', async () => {
    await seed({ sales_support_answers: { training: true }, programs: programs({ sales_support: { training: null } }) },
      { 'sales_support_answers/training': OWNER, 'programs/@p1/sales_support/training': PORTAL });
    const before = await read();
    const result = await relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }]);
    expect(result).toMatchObject({ changed: false, summary: { protected_target: 1, relocated: 0 } });
    expect(await read()).toEqual(before);
  });

  it('never replaces a cleared group protected as a whole', async () => {
    await seed({ sales_support_answers: { training: true }, programs: programs({ sales_support: {} }) },
      { 'sales_support_answers/training': OWNER, 'programs/@p1/sales_support': PORTAL });
    expect(await relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }]))
      .toMatchObject({ changed: false, summary: { protected_target: 1 } });
  });

  it('leaves a target that already has the same answer, and its attribution, untouched', async () => {
    await seed({ sales_method_answers: { buy_to_sell: true }, programs: programs({ methods: { buy_to_sell: true } }) },
      { 'sales_method_answers/buy_to_sell': OWNER, 'programs/@p1/methods/buy_to_sell': PORTAL });
    const before = await read();
    expect(await relocate([{ from: 'sales_method_answers/buy_to_sell', to: 'programs/@p1/methods/buy_to_sell' }]))
      .toMatchObject({ changed: false, summary: { already_present: 1 } });
    expect(await read()).toEqual(before);
  });

  it('does not replace a different unattributed value, and reports a source with nothing to move', async () => {
    await seed({ sales_method_answers: { buy_to_sell: false }, programs: programs({ methods: { buy_to_sell: true } }) }, {});
    expect(await relocate([
      { from: 'sales_method_answers/buy_to_sell', to: 'programs/@p1/methods/buy_to_sell' },
      { from: 'sales_support_answers/webshop', to: 'programs/@p2/sales_support/webshop' },
    ])).toMatchObject({ changed: false, summary: { conflicting_target: 1, missing_source: 1 } });
  });

  it('keeps whole-group protection when the owner emptied the source group', async () => {
    await seed({ sales_support_answers: {}, programs: programs() }, { sales_support_answers: OWNER });
    const result = await relocate([{ from: 'sales_support_answers', to: 'programs/@p1/sales_support' }]);
    expect(result).toMatchObject({ changed: true, summary: { relocated: 1 } });
    const after = await read();
    expect((after.fields?.programs as Array<Record<string, unknown>>)[0]!.sales_support).toEqual({});
    expect(after._provenance?.['programs/@p1/sales_support']).toMatchObject({ source: 'owner', relocated_from: 'sales_support_answers' });
    await expect(importPageFields(scope, pageId, { base_revision: await revision(), changes: [{ path: 'programs/@p1/sales_support/training', value: true }] }, 'research'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('refuses a stale revision, a program that does not exist and a pending owner review or draft of the fields', async () => {
    await seed({ sales_support_answers: { training: true }, programs: programs() }, { 'sales_support_answers/training': OWNER });
    await expect(relocatePageAnswers(scope, pageId, { base_revision: 'f'.repeat(64), reason: 'x', moves: [{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }] }, 'k'))
      .rejects.toMatchObject({ status: 409 });
    await expect(relocate([{ from: 'sales_support_answers/training', to: 'programs/@missing/sales_support/training' }])).rejects.toThrow('Expected one existing keyed item');

    await getStore().setDoc(reviewSettingsPath(scope), { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
    const current = await read();
    await submitOwnerProposal(scope, pageId, { installationId: 'trusted', subjectId: 'b'.repeat(64) }, {
      base_revision: answerRevision(current), request_id: 'relocation-pending-01', changes: { sales_support_answers: { training: false } },
    });
    await expect(relocate([{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }]))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('pending owner review') });
    // A review of other fields does not block it; a draft of the programs does.
    await mergeWorkingCopy(scope, { kind: 'page', id: pageId }, { programs: programs({ name: 'Draft' }) });
    await expect(relocate([{ from: 'sales_method_answers/buy_to_sell', to: 'programs/@p1/methods/buy_to_sell' }]))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('working copy') });
  });

  it('answers a dry run through the API for a site administrator, and nobody without a key', async () => {
    await seed({ sales_support_answers: { training: true }, programs: programs() }, { 'sales_support_answers/training': OWNER });
    const call = async (key: string) => relocateRoute({ params: { siteId: scope.siteId, pageId }, request: new Request(
      `http://localhost/api/v1/sites/${scope.siteId}/pages/${pageId}/relocate-answers`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision: await revision(), reason: 'Reviewed', dry_run: true, moves: [{ from: 'sales_support_answers/training', to: 'programs/@p1/sales_support/training' }] }) }),
      locals: {}, cookies: { get: () => undefined } } as never);
    const ok = await call(token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ dry_run: true, summary: { relocated: 1 } });
    expect((await call('tr_not_a_key')).status).toBe(401);
  });
});
