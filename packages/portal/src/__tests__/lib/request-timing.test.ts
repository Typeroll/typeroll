import { expect, it } from 'vitest';
import { authorizeRequestTiming, measureRequestStep, timedStoreTransport, withApiRequestTiming, withoutRequestTiming } from '../../lib/runtime/request-timing';
import { durableObjectTransport } from '../../lib/store/durable-object';

const request = () => new Request('https://portal.test/api/v1/sites/private-site/pages/private-page?secret=hidden', { method: 'PATCH', headers: { authorization: 'Bearer never-log-me' } });

it('reports actual RPC waits and conflicts without leaking paths, payloads or credentials', async () => {
  let clock = 0;
  const reports: Record<string, any>[] = [];
  const transport = timedStoreTransport(durableObjectTransport({
    get: () => { clock += 200; return null; },
    commit: () => { clock += 300; return { ok: false, conflict: 'private-document' }; },
  } as never));
  const response = await withApiRequestTiming(request(), async () => {
    await measureRequestStep('authentication', async () => { clock += 100; authorizeRequestTiming(); });
    await transport.get('private/document');
    await transport.commit([], []);
    clock += 25;
    return Response.json({ saved: true });
  }, { now: () => clock, log: report => reports.push(report) });
  expect(await response.json()).toEqual({ saved: true });
  expect(response.headers.get('server-timing')).toContain('total;dur=625');
  expect(response.headers.get('server-timing')).toContain('store_busy;dur=500');
  expect(reports[0]).toMatchObject({ total_ms: 625, store_busy_ms: 500, store_calls: 2, store_conflicts: 1,
    steps: { authentication: { ms: 100 }, store_get: { count: 1, ms: 200 }, store_commit: { count: 1, ms: 300 } } });
  expect(response.headers.get('x-typeroll-timing-id')).toBe(reports[0].timing_id);
  expect(JSON.stringify(reports)).not.toMatch(/private|never-log|secret|saved/);
});

it('counts overlapping RPC waits once and excludes detached background work', async () => {
  let clock = 0;
  const reports: Record<string, any>[] = [];
  await withApiRequestTiming(request(), async () => {
    authorizeRequestTiming();
    let finishFirst!: () => void, finishSecond!: () => void;
    const first = measureRequestStep('store_get', () => new Promise<void>(resolve => { finishFirst = resolve; }));
    clock = 10;
    const second = measureRequestStep('store_get', () => new Promise<void>(resolve => { finishSecond = resolve; }));
    clock = 20; finishFirst(); await first;
    clock = 30; finishSecond(); await second;
    await withoutRequestTiming(() => measureRequestStep('store_list', async () => {}));
    return Response.json({});
  }, { now: () => clock, log: report => reports.push(report) });
  expect(reports[0]).toMatchObject({ total_ms: 30, store_busy_ms: 30, store_calls: 2, steps: { store_get: { count: 2, ms: 40, max_ms: 20 } } });
  expect(reports[0].steps.store_list).toBeUndefined();
});

it('does not expose timing on refused authentication or unrelated routes', async () => {
  const reports: Record<string, any>[] = [];
  const response = await withApiRequestTiming(request(), async () => new Response(null, { status: 401 }), { log: report => reports.push(report) });
  expect(response.headers.has('server-timing')).toBe(false);
  const other = await withApiRequestTiming(new Request('https://portal.test/api/forms/example'), async () => { authorizeRequestTiming(); return Response.json({}); }, { log: report => reports.push(report) });
  expect(other.headers.has('server-timing')).toBe(false);
  expect(reports).toEqual([]);
});

it('records an authenticated failure without logging the error or changing it', async () => {
  const reports: Record<string, any>[] = [];
  const error = new Error('secret payload');
  await expect(withApiRequestTiming(request(), async () => {
    authorizeRequestTiming();
    await measureRequestStep('page_write', async () => { throw error; });
    return Response.json({});
  }, { log: report => reports.push(report) })).rejects.toBe(error);
  expect(reports[0]).toMatchObject({ status: 500, steps: { page_write: { count: 1 } } });
  expect(JSON.stringify(reports)).not.toContain(error.message);
});
