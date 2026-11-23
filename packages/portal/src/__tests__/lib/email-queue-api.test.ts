import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { ApplicationEmailQueues } from '../../lib/email/queue';
const state = vi.hoisted(() => ({ queues: null as any, identity: { installationId: 'app-one', scopes: ['email:send'] } as any, ready: true, limit: 10 }));
vi.mock('../../lib/email/queue-runtime', () => ({ applicationEmailQueues: () => state.queues }));
vi.mock('../../lib/email/configuration', () => ({ siteEmailQueuePolicy: async () => ({ ready: state.ready, daily_limit: state.limit, minimum_interval_minutes: 15 }) }));
vi.mock('../../lib/api-auth', async load => ({ ...await load<object>(), requireApiKey: async (request: Request) => ({ ok: true, value: {
  orgId: 'org', siteId: 'site', versionId: 'main', permission: 'admin', extensionIdentity: state.identity, request, path: new URL(request.url).pathname,
} }) }));
import { emailQueueApi } from '../../lib/email/queue-api';
const send = vi.fn(), prepare = vi.fn();
const call = (body?: unknown, id?: string, raw?: string) => emailQueueApi(new Request('https://cms.example.test/api/v1/sites/site/delivery/queues', {
  method: body === undefined && raw === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
}), 'site', id);
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); state.ready = true; state.limit = 10; state.identity = { installationId: 'app-one', scopes: ['email:send'] }; vi.clearAllMocks();
  state.queues = new ApplicationEmailQueues({ store: getStore(), now: Date.now, seal: x => x, open: x => x, authorize: async () => {}, preflight: async () => 'ready',
    prepare, send, acknowledge: async () => {}, unsubscribe: async () => 'https://cms.example.test/unsubscribe', receipt: async () => null });
});
const draft = { id: 'stable-reviewed-request', group: 'campaign', daily_limit: 100, interval_minutes: 1, entries: [{ id: 'one', to: 'synthetic@example.test', subject: 'Reviewed subject', text: 'Reviewed message' }] };
it('clamps approved queue policy and requires a fingerprint without preparing grants or sending', async () => {
  const response = await call(draft); expect(response.status).toBe(200);
  const { queue } = await response.json(); expect(queue).toMatchObject({ status: 'draft', daily_limit: 10, interval_ms: 900000 });
  expect((await call({ action: 'start', fingerprint: 'stale' }, queue.id)).status).toBe(409);
  expect((await call({ action: 'start', fingerprint: queue.fingerprint }, queue.id)).status).toBe(200);
  expect(send).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  state.identity.installationId = 'other-app'; expect((await call(undefined, queue.id)).status).toBe(404);
});
it('refuses non-installation keys, missing scope, disabled budget and unavailable account', async () => {
  state.identity = undefined; expect((await call(draft)).status).toBe(403);
  state.identity = { installationId: 'app-one', scopes: ['content:read'] }; expect((await call(draft)).status).toBe(403);
  state.identity.scopes = ['email:send']; state.limit = 0; expect((await call(draft)).status).toBe(409);
  state.limit = 10; state.ready = false; expect((await call(draft)).status).toBe(409); expect(send).not.toHaveBeenCalled();
});
it('keeps parser errors distinct from outages and bounds actual streamed bytes', async () => {
  expect((await call(undefined, undefined, 'null')).status).toBe(400);
  expect((await call(undefined, undefined, 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
});
