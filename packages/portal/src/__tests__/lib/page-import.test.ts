import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, type ContentType } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createApiKey } from '../../lib/api-keys';
import { readPageAuthority, importPageFields } from '../../lib/page-import';
import { vstore } from '../../lib/version-store';
import { answerRevision, submitOwnerProposal, readOwnerProposal, decideOwnerProposal, reviewSettingsPath } from '../../lib/owner-proposals';
import { decryptSecret } from '../../lib/secret-crypto';
import { POST as create } from '../../pages/api/v1/sites/[siteId]/pages/index';
import { POST as importRoute } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/import';
import { GET as authorityRoute } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/authority';

const scope = { orgId: 'import-test', siteId: 'test-site', versionId: 'main' };
const writable_by = ['portal', 'owner', 'import'] as const;
let token: string;
let pageId: string;
const definition = (name: string, type: string) => ({ name, type, label: name, writable_by: [...writable_by] });
const schema = {
  id: 'profiles', name: 'profiles', route_template: '/profiles/{slug}', fields: [
    definition('support', 'boolean'), definition('catalog', 'boolean'), definition('notes', 'richtext'),
    { ...definition('address', 'object'), fields: [definition('city', 'text')] },
    { ...definition('programs', 'array'), item_key: 'program_id', fields: [definition('program_id', 'text'), definition('name', 'text'), definition('legacy_anchor', 'text')] },
    { name: 'editor_only', type: 'text', label: 'Editor only', writable_by: ['portal'] },
  ],
} as ContentType;
async function request(handler: any, method: string, suffix: string, body?: unknown, headers?: Record<string, string>) {
  return handler({ params: { siteId: scope.siteId, pageId }, request: new Request(
    `http://localhost/api/v1/sites/${scope.siteId}/pages${suffix}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), locals: {}, cookies: { get: () => undefined } });
}
const read = () => vstore.page(scope.orgId, scope.siteId, 'main', pageId);
const pagePath = () => paths.page(scope.orgId, scope.siteId, pageId);
const payload = () => ({ title: 'Example', slug: 'example', content_type: 'profiles', status: 'published', blocks: [], write_mode: 'import', fields: {
  support: true, catalog: true, programs: [{ program_id: 'one/a~b', name: 'Original' }, { program_id: 'two', name: 'Keep sibling' }],
} });
const revision = async () => (await readPageAuthority(scope, pageId, ['support'])).revision;
const write = async (changes: unknown[], base_revision?: string) => importPageFields(scope, pageId, { base_revision: base_revision ?? await revision(), changes }, 'test-key');

describe('supported Page import authority', () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); makeTmpFixtures(); await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'synthetic-test-only-secret-not-a-credential';
    await getStore().setDoc(paths.site(scope.orgId, scope.siteId), { name: 'Test' });
    await getStore().setDoc(paths.contentType(scope.orgId, scope.siteId, 'profiles'), schema);
    ({ token } = await createApiKey({ orgId: scope.orgId, siteId: scope.siteId, name: 'Test', createdBy: 'test@example.test' }));
    const result = await request(create, 'POST', '', payload());
    expect(result.status).toBe(201);
    pageId = (await result.json()).page.id;
  });
  it('seeds through the real API at import priority; ordinary API creation remains editor authority', async () => {
    expect((await read())?._provenance?.support.source).toBe('import');
    const result = await request(create, 'POST', '', { ...payload(), slug: 'editor', write_mode: 'editor' });
    expect(result.status).toBe(201);
    expect((await vstore.page(scope.orgId, scope.siteId, 'main', (await result.json()).page.id))?._provenance?.support.source).toBe('api');
    expect((await request(create, 'POST', '', { ...payload(), slug: 'bad', fields: { editor_only: 'No' } })).status).toBe(409);
  });
  it('preserves every unspecified keyed item and accepted leaf when importing an anchor', async () => {
    await vstore.writePage(scope.orgId, scope.siteId, 'main', pageId, { fields: { programs: [
      { program_id: 'one/a~b', name: 'Accepted name' }, { program_id: 'two', name: 'Keep sibling' },
    ] } }, { actor: 'owner', actorId: 'owner-subject' });
    const before = (await read())!;
    const result = await request(importRoute, 'POST', '/profiles-example/import', { base_revision: await revision(),
      changes: [{ path: 'programs/@one~1a~0b/legacy_anchor', value: 'old-name' }] });
    expect(result.status).toBe(200);
    const after = (await read())!;
    expect(after.fields?.programs).toEqual([
      { program_id: 'one/a~b', name: 'Accepted name', legacy_anchor: 'old-name' }, { program_id: 'two', name: 'Keep sibling' },
    ]);
    for (const [key, source] of Object.entries(before._provenance!)) expect(after._provenance?.[key]).toEqual(source);
    expect(after._provenance?.['programs/@one~1a~0b/legacy_anchor'].source).toBe('import');
  });
  it('supports real owner approval of false, null and renamed programs, then rejects stale imports atomically', async () => {
    await getStore().setDoc(reviewSettingsPath(scope), { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
    const before = (await read())!;
    const submitted = await submitOwnerProposal(scope, before.id, { installationId: 'trusted', subjectId: 'a'.repeat(64) }, {
      base_revision: answerRevision(before), request_id: 'import-approval-00001', changes: { support: false, catalog: null,
        programs: [{ program_id: 'one/a~b', name: 'Approved' }, { program_id: 'two', name: 'Keep sibling' }] },
    });
    const proposal = await readOwnerProposal(scope, submitted.proposal_id);
    await decideOwnerProposal(scope, submitted.proposal_id, { token: decryptSecret(proposal.review.encrypted_token) }, { action: 'approve', request_id: 'import-approval-00002' });
    const accepted = (await read())!;
    expect(accepted.fields).toMatchObject({ support: false, catalog: null });
    for (const change of [{ path: 'support', value: true }, { path: 'catalog', value: true }, { path: 'programs/@one~1a~0b/name', value: 'Stale' }]) {
      await expect(write([{ path: 'notes', value: 'Must not persist' }, change])).rejects.toMatchObject({ status: 409 });
      expect(await read()).toEqual(accepted);
    }
    expect(await getStore().getDoc(paths.workingCopy(scope.orgId, scope.siteId, `page--${pageId}`))).toBeNull();
  });
  it('returns explicit, inherited and unattributed sources without private identity or values', async () => {
    const page = (await read())!;
    await getStore().setDoc(pagePath(), { ...page, _provenance: { ...page._provenance, address: { source: 'owner', actor: 'private@example.test', updated_at: '2026-01-01', source_url: 'https://private.example' } } });
    const response = await request(authorityRoute, 'GET', `/profiles-example/authority?paths=${encodeURIComponent(JSON.stringify(['support', 'address/city', 'notes']))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const data = await response.json();
    expect(data.fields).toEqual([
      { path: 'support', source: 'import', attribution: 'explicit', effective_path: 'support' },
      { path: 'address/city', source: 'owner', attribution: 'inherited', effective_path: 'address' },
      { path: 'notes', source: null, attribution: 'unattributed', effective_path: null },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/private@example|private\.example|Original/);
    await expect(write([{ path: 'address/city', value: 'New' }])).rejects.toMatchObject({ status: 409 });
  });
  it('rejects stale revisions, working copies and schema changes without mutation', async () => {
    const oldRevision = await revision();
    await write([{ path: 'support', value: false }]);
    await expect(write([{ path: 'catalog', value: false }], oldRevision)).rejects.toMatchObject({ status: 409 });
    const current = await revision();
    await getStore().setDoc(paths.contentType(scope.orgId, scope.siteId, 'profiles'), { ...schema, label_plural: 'Changed' });
    await expect(write([{ path: 'catalog', value: false }], current)).rejects.toMatchObject({ status: 409 });
    await getStore().setDoc(paths.workingCopy(scope.orgId, scope.siteId, `page--${pageId}`), { fields: { title: 'Draft' } });
    await expect(write([{ path: 'catalog', value: false }])).rejects.toThrow('working copy');
  });
  it('rejects a concurrent draft at the transaction boundary', async () => {
    const store = getStore(), original = store.compareAndReplaceDoc.bind(store);
    vi.spyOn(store, 'compareAndReplaceDoc').mockImplementationOnce(async (...args) => {
      await store.setDoc(paths.workingCopy(scope.orgId, scope.siteId, `page--${pageId}`), { fields: { title: 'Concurrent' } });
      return original(...args);
    });
    const before = await read();
    await expect(write([{ path: 'support', value: false }])).rejects.toMatchObject({ status: 409 });
    expect(await read()).toEqual(before);
  });
  it.each(['page', 'schema'])('rejects concurrent %s decisions at the transaction boundary', async kind => {
    const store = getStore(), original = store.compareAndReplaceDoc.bind(store);
    const before = (await read())!;
    vi.spyOn(store, 'compareAndReplaceDoc').mockImplementationOnce(async (...args) => {
      if (kind === 'page') await store.setDoc(pagePath(), { ...before, fields: { ...before.fields, catalog: null },
        _provenance: { ...before._provenance, catalog: { source: 'owner', actor: 'concurrent-owner', updated_at: new Date().toISOString() } } });
      else await store.setDoc(paths.contentType(scope.orgId, scope.siteId, 'profiles'), { ...schema, label_plural: 'Concurrent schema' });
      return original(...args);
    });
    await expect(write([{ path: 'support', value: false }])).rejects.toMatchObject({ status: 409 });
    expect((await read())?.fields?.support).toBe(true);
    if (kind === 'page') expect((await read())?.fields?.catalog).toBeNull();
  });
  it('isolates branch imports and binds revisions to the selected version', async () => {
    await getStore().setDoc(paths.version(scope.orgId, scope.siteId, 'migration'), { name: 'Migration', kind: 'branch', base_version_id: 'main' });
    const branch = { ...scope, versionId: 'migration' };
    await expect(importPageFields(branch, pageId, { base_revision: await revision(), changes: [{ path: 'support', value: false }] }, 'test')).rejects.toMatchObject({ status: 409 });
    const base_revision = (await readPageAuthority(branch, pageId, ['support'])).revision;
    const result = await importPageFields(branch, pageId, { base_revision, changes: [{ path: 'support', value: false }] }, 'test');
    expect(result.revision).toBe((await readPageAuthority(branch, pageId, ['support'])).revision);
    expect((await vstore.page(scope.orgId, scope.siteId, 'migration', pageId))?.fields?.support).toBe(false);
    expect((await read())?.fields?.support).toBe(true);
  });
  it('rejects unsafe paths, compound replacement, identity changes, unknown items, invalid values and forged provenance', async () => {
    const before = await read();
    for (const path of ['__proto__/polluted', 'programs', 'programs/@missing/name', 'programs/@two/program_id', 'address/constructor', 'support/child', 'notes~2'])
      await expect(write([{ path, value: 'bad' }])).rejects.toMatchObject({ status: 400 });
    await expect(write([{ path: 'support', value: 'true' }])).rejects.toMatchObject({ status: 400 });
    await expect(write([{ path: 'notes', value: 'x' }, { path: 'notes', value: 'y' }])).rejects.toThrow('Duplicate');
    await expect(importPageFields(scope, pageId, { base_revision: await revision(), changes: [], _provenance: {} }, 'test')).rejects.toMatchObject({ status: 400 });
    expect(await read()).toEqual(before);
    expect(({} as any).polluted).toBeUndefined();
  });
  it('sanitizes rich text and does not restamp unchanged research as confirmation', async () => {
    await write([{ path: 'notes', value: '<p>Safe</p><script>alert(1)</script>' }]);
    expect((await read())?.fields?.notes).toBe('<p>Safe</p>');
    const before = await read();
    expect(await write([{ path: 'notes', value: '<p>Safe</p>' }])).toMatchObject({ changed: false });
    expect(await read()).toEqual(before);
  });
  it('preserves retired stored fields while validating only addressed current schema leaves', async () => {
    const before = (await read())!;
    const programs = structuredClone(before.fields!.programs) as Array<Record<string, unknown>>;
    programs[0].retired_mirror = 'Old copy';
    const orphanSource = { source: 'owner' as const, actor: 'protected', updated_at: '2026-01-01' };
    await getStore().setDoc(pagePath(), { ...before, fields: { ...before.fields, programs, retired_top: 'Old top' },
      _provenance: { ...before._provenance, retired_top: orphanSource, 'programs/@one~1a~0b/retired_mirror': orphanSource } });
    await write([{ path: 'programs/@one~1a~0b/legacy_anchor', value: 'historical' }]);
    const after = (await read())!;
    expect(after.fields?.retired_top).toBe('Old top');
    expect((after.fields?.programs as any[])[0].retired_mirror).toBe('Old copy');
    expect(after._provenance?.retired_top).toEqual(orphanSource);
    expect(after._provenance?.['programs/@one~1a~0b/retired_mirror']).toEqual(orphanSource);
    for (const path of ['retired_top', 'programs/@one~1a~0b/retired_mirror'])
      await expect(write([{ path, value: null }])).rejects.toThrow('Unknown field path');
    expect(await read()).toEqual(after);
  });
  it('refuses changing a field-derived route', async () => {
    await getStore().setDoc(paths.contentType(scope.orgId, scope.siteId, 'profiles'), { ...schema, route_template: '/{support}' });
    await expect(write([{ path: 'support', value: false }])).rejects.toThrow('Page URL');
  });
  it('requires authentication and correct site/org scope', async () => {
    expect((await request(importRoute, 'POST', '/profiles-example/import', {}, { authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await request(authorityRoute, 'GET', '/profiles-example/authority?paths=%5B%22support%22%5D', undefined,
      { 'Typeroll-Organization': 'wrong-org' })).status).toBe(409);
  });
  it('refuses a read-only shared connection but admits its editor upgrade', async () => {
    const { writeShare } = await import('../../lib/shares');
    const share = { id: 'shared-import', site_id: scope.siteId, owner_org_id: scope.orgId,
      shared_with_org_id: 'partner', permission: 'read' as const, created_at: Date.now(), created_by: 'test' };
    await writeShare(share);
    const partner = (await createApiKey({ orgId: 'partner', siteId: null, name: 'Partner', createdBy: 'test' })).token;
    const headers = { authorization: `Bearer ${partner}` };
    const authorityUrl = `/profiles-example/authority?paths=${encodeURIComponent(JSON.stringify(['support']))}`;
    expect((await request(authorityRoute, 'GET', authorityUrl, undefined, headers)).status).toBe(403);
    expect((await request(importRoute, 'POST', '/profiles-example/import', {}, headers)).status).toBe(403);
    await writeShare({ ...share, permission: 'write' });
    const response = await request(authorityRoute, 'GET', authorityUrl, undefined, headers);
    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect((await request(importRoute, 'POST', '/profiles-example/import', {
      base_revision: revision, changes: [{ path: 'support', value: false }],
    }, headers)).status).toBe(200);
    expect((await read())?.fields?.support).toBe(false);
  });
});
