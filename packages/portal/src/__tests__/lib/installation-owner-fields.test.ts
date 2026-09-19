import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { answerRevision, proposalCollection, reviewSettingsPath } from '../../lib/owner-proposals';
const state = vi.hoisted(() => ({ ctx: { orgId: 'org', siteId: 'site', versionId: 'main', extensionIdentity: { installationId: 'app', scopes: ['content:owner'] } } as any }));
vi.mock('../../lib/api-auth', () => ({ requireApiKey: async () => ({ ok: true, value: state.ctx }), apiError: (error: string, status = 400) => Response.json({ error }, { status }), apiResponse: (_ctx: unknown, body: unknown, status = 200) => Response.json(body, { status }) }));
vi.mock('../../lib/owner-review-notifications', () => ({ notifyOwnerReviewer: vi.fn(async () => ({ status: 'failed' })) }));
import { GET, PUT } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/owner-fields';
const path = paths.page('org', 'site', 'record');
const call = async (changes: unknown, extra: Record<string, unknown> = {}, subject = 'a'.repeat(64)) => PUT({ request: new Request('https://cms.example/api/v1/sites/site/pages/record/owner-fields', {
  method: 'PUT', headers: { 'X-Typeroll-Owner-Subject': subject }, body: JSON.stringify({ changes, base_revision: answerRevision(await getStore().getDoc(path)), request_id: 'request-0000000001', ...extra }),
}), params: { siteId: 'site', pageId: 'record' } } as never);
describe('installation owner-authorized proposals', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore(); process.env.INTEGRATIONS_SECRET_KEY = 'synthetic-owner-api-test-secret-not-real';
    state.ctx.extensionIdentity = { installationId: 'app', scopes: ['content:owner'] };
    await getStore().setDoc(path, { title: 'Synthetic profile', content_type: 'business', fields: { description: 'Original', tags: ['one'], private: 'keep' } });
    await getStore().setDoc(paths.contentType('org', 'site', 'business'), { id: 'business', fields: [
      { name: 'description', type: 'richtext', label: 'Description', writable_by: ['owner', 'portal'] },
      { name: 'tags', type: 'multiselect', label: 'Tags', options: ['one', 'two'], writable_by: ['owner', 'portal'] },
      { name: 'private', type: 'text', label: 'Private', writable_by: ['portal'] },
    ], page_field_rules: { title: { writable_by: ['owner', 'portal'] } } });
    await getStore().setDoc(reviewSettingsPath(state.ctx), { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
  });
  it('exposes only owner fields, a revision and no private actor information', async () => {
    await getStore().updateDoc(path, { _provenance: { description: { source: 'import', actor: 'private-actor', updated_at: 'T' } } });
    const response = await GET({ request: new Request('https://cms.example'), params: { pageId: 'record' } } as never);
    const body = await response.json();
    expect(body.fields.map((field: any) => field.name)).toEqual(['description', 'tags', 'title']);
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(body)).not.toContain('private-actor');
    delete state.ctx.extensionIdentity; expect((await call({ title: 'Changed' })).status).toBe(403);
  });
  it('reports incomplete review setup before an app can issue editing links', async () => {
    await getStore().updateDoc(reviewSettingsPath(state.ctx), { enabled: false });
    const response = await GET({ request: new Request('https://cms.example'), params: { pageId: 'record' } } as never);
    expect(await response.json()).toMatchObject({ review_ready: false });
    expect((await call({ title: 'Changed' })).status).toBe(409);
  });
  it('rejects field escalation, invalid metadata and missing verified subjects', async () => {
    expect((await call({ private: 'overwrite' })).status).toBe(403);
    expect((await call({ title: { bad: true } })).status).toBe(400);
    expect((await call({ tags: ['unknown'] })).status).toBe(400);
    expect((await call({ title: 'Changed' }, {}, '')).status).toBe(400);
  });
  it('preserves portal precedence', async () => {
    await getStore().updateDoc(path, { _provenance: { description: { source: 'portal', actor: 'editor', updated_at: 'T' } } });
    expect((await call({ description: 'Overwrite' })).status).toBe(409);
  });
  it('sanitizes and durably queues owner changes despite mail failure, without mutating accepted content', async () => {
    const before = await getStore().getDoc(path);
    const response = await call({ description: '<p>Updated</p><script>alert(1)</script>', tags: ['one', 'two'] });
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ status: 'pending', notification: 'failed' });
    expect(await getStore().getDoc(path)).toEqual(before);
    const proposals = await getStore().listDocs<any>(proposalCollection(state.ctx));
    expect(proposals).toHaveLength(1); expect(proposals[0].changes).toEqual({ description: '<p>Updated</p>', tags: ['one', 'two'] });
  });
});
