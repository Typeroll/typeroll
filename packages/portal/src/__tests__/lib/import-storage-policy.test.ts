import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { importStorageStatus, requireImportStorage } from '../../lib/media/import-policy';
import { WorkflowEngine } from '../../lib/workflows/engine';
import { type WorkflowDef, reviewGate } from '../../lib/workflows/types';
const guard = vi.hoisted(() => ({ orgId: 'org', siteId: 'site', permission: 'write' }));
vi.mock('../../lib/api-auth', () => ({
  requireApiKey: vi.fn(async () => ({ ok: true, value: guard })),
  apiError: (error: string, status = 400) => Response.json({ error }, { status }),
  apiResponse: (_ctx: unknown, data: unknown) => Response.json(data),
}));
const run = vi.fn(async () => ({}));
const def: WorkflowDef = { type: 'migration', label: 'Import', description: 'Synthetic', steps: [{ name: 'read_source', label: 'Read', run }] };
const create = (definition = def) => new WorkflowEngine().create({ orgId: 'org', siteId: 'site', def: definition, triggeredBy: 'manual', createdBy: 'synthetic-user' });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); run.mockClear(); guard.permission = 'write'; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Source must not be fetched'); })); });
afterEach(() => vi.unstubAllGlobals());
async function connect() { await getStore().setDoc(connectionPath('org', 'cloudflare'), { revision: 'ready', status: 'connected', media_ready: true, encrypted_credentials: 'synthetic', cloudflare: { account_id: 'a'.repeat(32), bucket: 'originals', public_bucket: 'public' } }); }

it.each(['missing', 'unverified', 'disconnected', 'no-credentials', 'no-bucket'])('blocks imports with %s storage before creating a workflow', async state => {
  if (state !== 'missing') {
    await connect();
    await getStore().updateDoc(connectionPath('org', 'cloudflare'), state === 'unverified' ? { media_ready: false } : state === 'disconnected' ? { status: 'disconnected' } : state === 'no-credentials' ? { encrypted_credentials: null } : { cloudflare: { account_id: 'a'.repeat(32) } });
  }
  await expect(create()).rejects.toMatchObject({ code: 'import_storage_required', status: 409 });
  expect(await getStore().listDocs(paths.workflows('org'))).toHaveLength(0);
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('requires the owning organization storage, independently of build provider or a different organization connection', async () => {
  await connect();
  await expect(requireImportStorage('other-org')).rejects.toMatchObject({ code: 'import_storage_required' });
  expect(await importStorageStatus('org')).toMatchObject({ ready: true });
  const id = await create();
  expect((await new WorkflowEngine().start('org', id, def)).status).toBe('completed');
  expect(run).toHaveBeenCalledTimes(1);
});

it('rechecks storage before each step and before resuming a review', async () => {
  await connect();
  const paused: WorkflowDef = { ...def, steps: [{ name: 'review', label: 'Review', run: async () => reviewGate('Review') }, ...def.steps] };
  const id = await create(paused);
  await new WorkflowEngine().start('org', id, paused);
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected' });
  await expect(new WorkflowEngine().resume('org', id, paused)).rejects.toMatchObject({ code: 'import_storage_required' });
  expect(run).not.toHaveBeenCalled();
  expect(await getStore().getDoc(`${paths.workflows('org')}/${id}`)).toMatchObject({ status: 'paused_for_review' });
});

it('allows unrelated authoring workflows without an import connection', async () => {
  const id = await create({ ...def, type: 'site_planning' });
  expect(id).toMatch(/^wf_/);
});

it.each(['media', 'sitemap', 'gsc'])('returns actionable 409 for %s API import before any source fetch or import write', async kind => {
  const { POST } = await (kind === 'media' ? import('../../pages/api/v1/sites/[siteId]/media/import') : kind === 'sitemap' ? import('../../pages/api/v1/sites/[siteId]/migration-urls/import-sitemap') : import('../../pages/api/v1/sites/[siteId]/migration-urls/import-gsc'));
  const response = await POST({ request: new Request('https://cms.example.com/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), params: { siteId: 'site' } } as never);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'import_storage_required', settings_url: '/app/settings/publishing#media-title' });
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});
