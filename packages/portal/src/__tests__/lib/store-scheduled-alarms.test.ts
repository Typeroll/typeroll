// Store objects deliver their own scheduled work from alarms, in real workerd
// (Durable Object SQLite, alarms, a self service binding), offline.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NEVER = Number.MAX_SAFE_INTEGER;
let mf: Miniflare, dir: string;
// The store modules import lib/datastore only for its read-only snapshot helper,
// and the scheduling transport only for local timers; neither runs in an object.
const stubs: Plugin = { name: 'portal-stubs', setup(b) {
  b.onResolve({ filter: /\/datastore(\.js)?$/ }, () => ({ path: fileURLToPath(new URL('../workers/datastore-stub.ts', import.meta.url)) }));
  b.onResolve({ filter: /^\.\/transport$/ }, () => ({ path: 'transport', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function deliverCommitted() {}', loader: 'ts' }));
} };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'typeroll-alarms-'));
  const entry = fileURLToPath(new URL('../workers/scheduled-store-worker.ts', import.meta.url));
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: path.join(dir, 'worker.js'),
    external: ['cloudflare:workers', 'node:*'], plugins: [stubs], logLevel: 'silent' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'portal', modules: true, script: readFileSync(path.join(dir, 'worker.js'), 'utf8'),
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { STORE: { className: 'DocumentStore', useSQLite: true } },
    serviceBindings: { SCHEDULER: { name: 'portal', entrypoint: 'Scheduler' } } } as never));
}, 60_000);
afterAll(async () => { await mf?.dispose(); rmSync(dir, { recursive: true, force: true }); });

const call = async (object: string, method: string, ...args: unknown[]) => {
  const response = await mf.dispatchFetch('http://store/', { method: 'POST', body: JSON.stringify({ object, method, args }) });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 500));
  return JSON.parse(text);
};
const putWork = (object: string, id: string, due: number, generation = 'g1') => call(object, 'commit', [], [{ path: `scheduled_work/${id}`, op: 'set',
  data: { kind: 'form_webhook_retry', source: `organizations/o/sites/s/x/${id}`, generation, due_at: due, payload: {}, lease_until: 0, lease_owner: null } }]);
const delivered = async (object: string, id: string, generation = 'g1') => (await call(object, 'get', `deliveries/${id}-${generation}`))?.data.count ?? 0;
const waitFor = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 10_000, interval: 50 });

it('delivers due work once from the alarm and re-arms for the next item', async () => {
  const object = 'site:alarm-order', now = Date.now();
  await putWork(object, 'late', now + 1_500);
  await putWork(object, 'early', now + 200);
  expect(await call(object, 'alarmAt')).toBe(now + 200);
  await waitFor(async () => expect(await delivered(object, 'early')).toBe(1));
  expect(await delivered(object, 'late')).toBe(0);
  expect(await call(object, 'alarmAt')).toBeLessThanOrEqual(now + 1_500);
  await waitFor(async () => expect(await delivered(object, 'late')).toBe(1));
  // Both consumed exactly once; nothing left to deliver.
  await new Promise(resolve => setTimeout(resolve, 500));
  expect([await delivered(object, 'early'), await delivered(object, 'late')]).toEqual([1, 1]);
  expect((await call(object, 'get', 'scheduled_work/early')).data.due_at).toBe(NEVER);
}, 30_000);

it('converges after a crash between the commit and the delivery', async () => {
  const object = 'site:alarm-crash';
  await call(object, 'commit', [], [{ path: 'control/crash', op: 'set', data: { remaining: 2 } }]);
  await putWork(object, 'job', Date.now());
  await waitFor(async () => expect(await delivered(object, 'job')).toBe(1));
  expect((await call(object, 'get', 'control/crash')).data.remaining).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await delivered(object, 'job')).toBe(1);
}, 30_000);

it('drains an outbox entry left by a crashed writer, and reports pending work to the global index', async () => {
  const object = 'site:alarm-outbox', far = Date.now() + 3_600_000;
  // The writer committed the site document with its organization copy in the outbox, then died.
  await call(object, 'commit', [], [
    { path: 'organizations/o/sites/s', op: 'set', data: { name: 'Site' } },
    { path: '_outbox/crashed', op: 'set', data: { writes: [{ shard: 'org:o', path: 'organizations/o/sites/s', data: { name: 'Site' } }], created_at: Date.now() } },
  ]);
  await putWork(object, 'future', far);
  await waitFor(async () => expect(await call('org:o', 'get', 'organizations/o/sites/s')).toMatchObject({ data: { name: 'Site' } }));
  await waitFor(async () => expect(await call(object, 'list', '_outbox')).toEqual([]));
  expect(await call('global', 'get', `scheduled_objects/${object}`)).toMatchObject({ data: { object, due_at: far } });
  expect(await call(object, 'alarmAt')).toBe(far);
  // The sweep's poke rebuilds and re-arms an object whose alarm was lost.
  expect(await call(object, 'wake')).toBe(far);
}, 30_000);
