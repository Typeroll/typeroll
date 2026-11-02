// Durable workflow runs (Moveria NO-05). url_parity on moveria-no (810 URLs)
// stopped at 724/810 and 809/810 and stayed `running`: the run executed as a
// background promise of the request that started it, and Cloud Run with
// request-based CPU starves and recycles such work. Runs now execute in short
// chunks delivered by a durable queue, each committed with a compare-and-
// update on the chunk id, so they finish, resume from their cursor after a
// lost chunk, and ignore duplicate deliveries. A fake queue, a fixed clock
// and a fake network keep this deterministic; the store is the local
// fixture store.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const net = vi.hoisted(() => ({
  calls: new Map<string, number>(),
  clock: { t: 0 },
  /** Advance the fake clock this much per request, as a slow host would. */
  msPerRequest: 1_000,
  onRequest: null as null | ((path: string) => void),
}));
vi.mock('../../lib/deploy/public-response', () => ({
  publicationResponse: vi.fn(async (url: URL) => {
    net.calls.set(url.pathname, (net.calls.get(url.pathname) ?? 0) + 1);
    net.clock.t += net.msPerRequest;
    net.onRequest?.(url.pathname);
    return { response: new Response(null, { status: 200 }), close: async () => {} };
  }),
}));

const links = vi.hoisted(() => ({ calls: new Map<string, number>() }));
vi.mock('../../lib/net/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/net/safe-fetch')>()),
  safeFetch: vi.fn(async (url: string) => {
    links.calls.set(url, (links.calls.get(url) ?? 0) + 1);
    return new Response(null, { status: url.endsWith('/gone') ? 404 : 200 });
  }),
}));

import { getStore } from '../../lib/datastore';
import { WorkflowEngine, WORKFLOW_CHUNK_LEASE_MS } from '../../lib/workflows/engine';
import type { WorkflowChunkQueue, WorkflowChunkRef } from '../../lib/workflows/queue';
import {
  cancelRun, settleInterruptedRun,
  WORKFLOW_INTERRUPTED, WORKFLOW_MAX_RESUMES, WORKFLOW_RESUME_AFTER_MS,
} from '../../lib/workflows/run-lifecycle';
import { startSiteWorkflow, workflowSummary } from '../../lib/workflows/service';
import { urlParityWorkflow } from '../../lib/workflows/url-parity';
import { LINK_CHECK_LINKS_PER_CHUNK, linkCheckWorkflow } from '../../lib/workflows/link-check';
import { isStepYield, type WorkflowContext, type WorkflowRecord } from '../../lib/workflows/types';
import { runDueScheduledWork } from '../../lib/scheduling/worker';

const ORG = 'moveria';
const SITE = 'moveria-no';
const URLS = 810;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const wfPath = (id: string) => `${paths.workflows(ORG)}/${id}`;
const read = async (id: string) => (await getStore().getDoc<WorkflowRecord>(wfPath(id)))!;

class FakeQueue implements WorkflowChunkQueue {
  refs: WorkflowChunkRef[] = [];
  async enqueue(ref: WorkflowChunkRef) { this.refs.push(ref); }
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  net.calls.clear();
  net.clock.t = NOW;
  net.msPerRequest = 1_000;
  net.onRequest = null;
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'Moveria NO', hosting_adapter: 'cloudflare',
    hosting_config: { fallback_subdomain: 'moveria-no.sites.example.com' },
    created_at: '2026-10-01T00:00:00.000Z',
  });
  await store.setDoc(paths.settings(ORG, SITE), { site_name: 'Moveria NO', trailing_slash: 'ignore' });
  await Promise.all(Array.from({ length: URLS }, (_, i) => store.setDoc(paths.migrationUrl(ORG, SITE, `u${i}`), {
    path: `/flytting/${i}`, full_url: `https://old.example.com/flytting/${i}`, observed_paths: [`/flytting/${i}`],
    sources: ['sitemap'], found_at: '2026-10-01T00:00:00.000Z',
  })));
});

function setup() {
  const queue = new FakeQueue();
  const engine = new WorkflowEngine(getStore(), { now: () => net.clock.t, queue });
  const start = async () => {
    const id = await engine.create({ orgId: ORG, siteId: SITE, def: urlParityWorkflow, triggeredBy: 'manual', createdBy: 'person' });
    const started = await engine.start(ORG, id, urlParityWorkflow);
    expect(started.status).toBe('running');
    return id;
  };
  /** Deliver queued chunks in order, as the queue would; returns how many ran. */
  const drive = async (limit = 100) => {
    let delivered = 0;
    for (let ref = queue.refs.shift(); ref; ref = queue.refs.shift()) {
      await engine.runChunk(ref);
      if (++delivered > limit) throw new Error('run did not finish');
    }
    return delivered;
  };
  return { queue, engine, start, drive };
}

/** Each inventory URL was requested exactly once. */
function expectEachUrlCheckedOnce() {
  expect(net.calls.size).toBe(URLS);
  expect([...net.calls.values()].every((n) => n === 1)).toBe(true);
}

async function expectFinished(id: string) {
  const wf = await read(id);
  expect(wf.status).toBe('paused_for_review');
  expect(wf.results?.summary).toMatchObject({ checked: URLS, ok: URLS, missing: 0, error: 0 });
  expect(wf.results?.all_results).toHaveLength(URLS);
  expect(wf.chunk).toBeNull();
  expectEachUrlCheckedOnce();
  return wf;
}

describe('url_parity in chunks', () => {
  it('completes an 810-URL check across many chunks, each URL requested once', async () => {
    const { queue, start, drive } = setup();
    const id = await start();
    // start() only recorded the run and enqueued its first chunk.
    expect(net.calls.size).toBe(0);
    expect(queue.refs).toHaveLength(1);

    const chunks = await drive();

    expect(chunks).toBeGreaterThan(10);
    const wf = await expectFinished(id);
    expect(wf.review_message).toMatch(/Every checked URL resolves/);
    expect(wf.log).toContain('[check_urls] Checked 800/810');
    // The public contract is unchanged: no chunk internals in the summary.
    expect(workflowSummary({ ...wf, id })).not.toHaveProperty('chunk');
    expect(await getStore().getDoc(paths.migrationVerification(ORG, SITE))).toMatchObject({ complete: true, checked: URLS });
  });

  it('resumes a chunk whose process died after claiming it, from its cursor, once its lease expires', async () => {
    const { queue, engine, start, drive } = setup();
    const id = await start();
    await engine.runChunk(queue.refs.shift()!);
    await engine.runChunk(queue.refs.shift()!);
    const lost = queue.refs.shift()!;
    // The process that received this delivery claimed it and died.
    const claimed = (await read(id)).chunk!;
    await getStore().updateDoc(wfPath(id), { chunk: { ...claimed, lease_owner: 'dead-process', lease_until: net.clock.t + WORKFLOW_CHUNK_LEASE_MS } });
    const requested = net.calls.size;
    expect(requested).toBeGreaterThan(0);

    // The queue's retry finds the chunk held and is told when to come back.
    expect(await engine.runChunk(lost)).toEqual({ outcome: 'busy', leaseUntil: net.clock.t + WORKFLOW_CHUNK_LEASE_MS });
    expect(net.calls.size).toBe(requested);

    net.clock.t += WORKFLOW_CHUNK_LEASE_MS + 1;
    expect((await engine.runChunk(lost)).outcome).toBe('continued');
    await drive();
    await expectFinished(id);
  });

  it('resumes a run whose chunk was never delivered when a read finds it stale', async () => {
    const { queue, engine, start, drive } = setup();
    const id = await start();
    await engine.runChunk(queue.refs.shift()!);
    const dropped = queue.refs.shift()!;
    const before = await read(id);
    expect(before.progress?.completed).toBeGreaterThan(0);

    net.clock.t += WORKFLOW_RESUME_AFTER_MS + 1;
    const settled = await settleInterruptedRun(getStore(), wfPath(id), { ...before, id }, net.clock.t, { queue, orgId: ORG });

    expect(settled.status).toBe('running');
    expect(settled.chunk).toMatchObject({ resumes: 1, step_index: 0, cursor: before.chunk!.cursor });
    expect(settled.log?.at(-1)).toBe('[check_urls] Interrupted; resuming from saved progress (attempt 1 of 3).');
    expect(queue.refs).toEqual([{ orgId: ORG, workflowId: id, chunkId: settled.chunk!.id }]);
    expect(settled.chunk!.id).not.toBe(dropped.chunkId);

    // The original delivery arriving late does nothing.
    const requested = net.calls.size;
    expect((await engine.runChunk(dropped)).outcome).toBe('superseded');
    expect(net.calls.size).toBe(requested);

    // Progress resets the resume count.
    await engine.runChunk(queue.refs.shift()!);
    expect((await read(id)).chunk?.resumes).toBe(0);
    await drive();
    await expectFinished(id);
  });

  it('closes a run as interrupted only after resuming keeps failing', async () => {
    const { queue, start } = setup();
    const id = await start();
    for (let attempt = 1; attempt <= WORKFLOW_MAX_RESUMES; attempt++) {
      queue.refs = []; // every delivery is lost
      net.clock.t += WORKFLOW_RESUME_AFTER_MS + 1;
      const settled = await settleInterruptedRun(getStore(), wfPath(id), { ...(await read(id)), id }, net.clock.t, { queue, orgId: ORG });
      expect(settled).toMatchObject({ status: 'running', chunk: { resumes: attempt } });
    }
    queue.refs = [];
    net.clock.t += WORKFLOW_RESUME_AFTER_MS + 1;
    const closed = await settleInterruptedRun(getStore(), wfPath(id), { ...(await read(id)), id }, net.clock.t, { queue, orgId: ORG });

    expect(closed).toMatchObject({ status: 'failed', failure_code: WORKFLOW_INTERRUPTED, chunk: null });
    expect(closed.failure_reason).toMatch(/could not be resumed after 3 attempt\(s\).*start a new run/);
    expect(queue.refs).toHaveLength(0);
    expect((await read(id)).status).toBe('failed');
  });
});

describe('duplicate deliveries', () => {
  it('runs a chunk delivered twice at once only once', async () => {
    const { queue, engine, start, drive } = setup();
    const id = await start();
    const first = queue.refs.shift()!;

    const outcomes = (await Promise.all([engine.runChunk(first), engine.runChunk(first)])).map((o) => o.outcome).sort();

    expect(outcomes[1]).toBe('continued');
    expect(['busy', 'superseded']).toContain(outcomes[0]);
    expect(queue.refs).toHaveLength(1);
    expect([...net.calls.values()].every((n) => n === 1)).toBe(true);
    await drive();
    await expectFinished(id);
  });

  it('ignores a late duplicate, and re-sends a committed chunk whose own delivery was lost', async () => {
    const { queue, engine, start, drive } = setup();
    const id = await start();
    const first = queue.refs.shift()!;
    await engine.runChunk(first);
    const committed = await read(id);

    // A duplicate right after the commit changes nothing.
    expect((await engine.runChunk(first)).outcome).toBe('superseded');
    expect(await read(id)).toEqual(committed);
    expect(queue.refs).toHaveLength(1);

    // The process died between committing the chunk and enqueueing the next
    // one: a later retry of the old delivery sends the current chunk again.
    const lost = queue.refs.shift()!;
    net.clock.t += 60_000;
    expect((await engine.runChunk(first)).outcome).toBe('superseded');
    expect(queue.refs).toEqual([lost]);
    await drive();
    await expectFinished(id);
  });
});

describe('cancel', () => {
  it('takes effect at the next chunk boundary', async () => {
    const { queue, engine, start } = setup();
    const id = await start();
    await engine.runChunk(queue.refs.shift()!);
    const requested = net.calls.size;

    await cancelRun(getStore(), wfPath(id), 'person', net.clock.t);
    expect((await engine.runChunk(queue.refs.shift()!)).outcome).toBe('not_running');

    expect(net.calls.size).toBe(requested);
    expect(queue.refs).toHaveLength(0);
    expect(await read(id)).toMatchObject({ status: 'cancelled', results: {} });
  });

  it('stops a chunk in progress from committing or enqueueing more', async () => {
    const { queue, engine, start } = setup();
    const id = await start();
    let seen = 0;
    let cancelled: Promise<unknown> | null = null;
    net.onRequest = () => { if (++seen === 10) cancelled = cancelRun(getStore(), wfPath(id), 'person', net.clock.t); };

    expect((await engine.runChunk(queue.refs.shift()!)).outcome).toBe('stopped');
    await cancelled;

    expect(queue.refs).toHaveLength(0);
    const wf = await read(id);
    expect(wf).toMatchObject({ status: 'cancelled', results: {} });
    expect(wf.log?.at(-1)).toBe('[check_urls] cancelled by person');
  });
});

describe('without Cloud Tasks', () => {
  it('completes inline, one chunk after another', async () => {
    const engine = new WorkflowEngine(getStore(), { now: () => net.clock.t, queue: 'inline' });
    const id = await engine.create({ orgId: ORG, siteId: SITE, def: urlParityWorkflow, triggeredBy: 'manual', createdBy: 'person' });
    expect((await engine.start(ORG, id, urlParityWorkflow)).status).toBe('paused_for_review');
    await expectFinished(id);
  });

  it('completes through the scheduled-work index, as the self-host worker and publish sweep run it', async () => {
    expect(process.env.DEPLOY_QUEUE).not.toBe('cloud_tasks');
    net.msPerRequest = 0;
    const { workflowId } = await startSiteWorkflow({ orgId: ORG, siteId: SITE, type: 'url_parity', versionId: 'main', createdBy: 'person' });
    expect((await read(workflowId)).status).toBe('running');

    let sweeps = 0;
    while ((await read(workflowId)).status === 'running') {
      await runDueScheduledWork();
      if (++sweeps > 50) throw new Error('run did not finish');
    }

    expect(sweeps).toBeGreaterThan(1);
    await expectFinished(workflowId);
  });
});

describe('link_check in chunks', () => {
  it('keeps broken links found in earlier chunks and checks no link twice', async () => {
    const all = Array.from({ length: 450 }, (_, i) => ({
      page_id: `p${i % 9}`, page_title: 'Page', text: 'link', url: `https://example.com/${i}/${i % 50 === 0 ? 'gone' : 'ok'}`,
    }));
    const verify = linkCheckWorkflow.steps.find((step) => step.name === 'verify_links')!;
    let cursor: unknown;
    let chunks = 0;
    for (;;) {
      const ctx = {
        orgId: ORG, siteId: SITE, workflowId: 'wf_links', config: {}, state: { links: all }, store: getStore(),
        log: () => {}, setProgress: () => {}, cursor, shouldYield: () => false,
      } satisfies WorkflowContext;
      const result = await verify.run(ctx);
      chunks++;
      if (!isStepYield(result)) {
        expect(chunks).toBe(Math.ceil(all.length / LINK_CHECK_LINKS_PER_CHUNK));
        expect(result).toMatchObject({ results: { total_links: 450 } });
        expect((result as { results: { broken_links: unknown[] } }).results.broken_links).toHaveLength(9);
        break;
      }
      cursor = JSON.parse(JSON.stringify(result.cursor));
    }
    expect(links.calls.size).toBe(450);
    expect([...links.calls.values()].every((n) => n === 1)).toBe(true);
  });
});
