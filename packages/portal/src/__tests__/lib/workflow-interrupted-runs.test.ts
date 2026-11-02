// Workflow runs execute inline in the portal process. A deploy that replaces
// the process mid-run (Moveria: url_parity stopped at 606/630 URLs) used to
// leave the run `running` for ever. The engine now records heartbeat_at, and
// reads close a run without one as failed/workflow_interrupted, once and
// conditionally. A fake store and a fixed clock keep this deterministic.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../../lib/datastore';
import type { WorkflowDef, WorkflowRecord } from '../../lib/workflows/types';

const fake = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../lib/datastore', () => ({ getStore: () => fake.store }));

import { WorkflowEngine } from '../../lib/workflows/engine';
import {
  cancelRun, isInterrupted, settleInterruptedRun,
  WORKFLOW_HEARTBEAT_INTERVAL_MS, WORKFLOW_INTERRUPTED, WORKFLOW_STALE_AFTER_MS,
} from '../../lib/workflows/run-lifecycle';
import { cancelSiteWorkflow, listSiteWorkflows, readSiteWorkflow, WorkflowRequestError } from '../../lib/workflows/service';

type Doc = Record<string, any>;

/** In-memory store: records every write, and can change a doc just before a conditional write checks it. */
class FakeStore {
  docs = new Map<string, Doc>();
  writes: Array<{ kind: 'set' | 'update' | 'conditional'; path: string; data: Doc; applied: boolean }> = [];
  beforeConditional: ((path: string) => void) | null = null;

  read<T>(path: string) {
    const doc = this.docs.get(path);
    return doc ? (structuredClone({ ...doc, id: path.split('/').pop()! }) as T & { id: string }) : null;
  }
  async getDoc<T>(path: string) {
    return this.read<T>(path);
  }
  async setDoc(path: string, data: Doc) {
    this.writes.push({ kind: 'set', path, data, applied: true });
    this.docs.set(path, structuredClone(data));
  }
  async updateDoc(path: string, data: Doc) {
    this.writes.push({ kind: 'update', path, data, applied: true });
    this.docs.set(path, structuredClone({ ...(this.docs.get(path) ?? {}), ...data }));
  }
  async listDocs<T>(collection: string) {
    const out: Array<T & { id: string }> = [];
    for (const path of this.docs.keys()) {
      if (path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes('/')) out.push((await this.getDoc<T>(path))!);
    }
    return out;
  }
  async compareAndUpdateDoc<T>(path: string, check: (current: T & { id: string }) => boolean, data: Doc) {
    const hook = this.beforeConditional;
    this.beforeConditional = null;
    hook?.(path);
    // Check and write without yielding, atomic like the real stores.
    const current = this.read<T>(path);
    const applied = !!current && check(current);
    this.writes.push({ kind: 'conditional', path, data, applied });
    if (!applied) return null;
    this.docs.set(path, structuredClone({ ...this.docs.get(path), ...data }));
    return current;
  }
  conditionalWrites(path: string) {
    return this.writes.filter((w) => w.kind === 'conditional' && w.path === path && w.applied);
  }
}

const ORG = 'org';
const SITE = 'moveria-ch';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const wfPath = (id: string) => `${paths.workflows(ORG)}/${id}`;

function run(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: 'wf_1793622863467_rtgb7o',
    site_id: SITE,
    type: 'url_parity',
    status: 'running',
    config: {},
    current_step: 'check_urls',
    step_index: 0,
    progress: { total: 630, completed: 606 },
    log: ['[check_urls] Checked 600/630'],
    triggered_by: 'manual',
    created_by: 'person',
    started_at: ago(60 * MINUTE),
    ...overrides,
  };
}

function seed(store: FakeStore, wf: WorkflowRecord): WorkflowRecord {
  const { id, ...doc } = wf;
  store.docs.set(wfPath(id), structuredClone(doc));
  return wf;
}

afterEach(() => {
  vi.useRealTimers();
  fake.store = null;
});

describe('closing interrupted runs on read', () => {
  it('closes a running run without a heartbeat for longer than the threshold, once', async () => {
    const store = new FakeStore();
    const wf = seed(store, run({ heartbeat_at: ago(WORKFLOW_STALE_AFTER_MS + 1) }));

    const closed = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(wf.id), wf, NOW);

    expect(closed).toMatchObject({ status: 'failed', failure_code: WORKFLOW_INTERRUPTED, failed_at: new Date(NOW).toISOString() });
    expect(closed.failure_reason).toMatch(/stopped making progress during step check_urls/);
    expect(closed.failure_reason).toMatch(/service restarted/);
    expect(closed.failure_reason).toMatch(/start a new run/);
    expect(store.docs.get(wfPath(wf.id))).toMatchObject({ status: 'failed', failure_code: WORKFLOW_INTERRUPTED, progress: { completed: 606 } });
    expect(closed.log?.at(-1)).toMatch(/^\[check_urls\] ERROR: This run stopped making progress/);

    // A second read sees the closed run and writes nothing.
    const again = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(wf.id), (await store.getDoc<WorkflowRecord>(wfPath(wf.id)))!, NOW + MINUTE);
    expect(again.status).toBe('failed');
    expect(store.conditionalWrites(wfPath(wf.id))).toHaveLength(1);
  });

  it('closes a legacy run that never recorded a heartbeat by when it started (the Moveria run)', async () => {
    const store = new FakeStore();
    const wf = seed(store, run());
    const closed = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(wf.id), wf, NOW);
    expect(closed.status).toBe('failed');
    expect(closed.failure_code).toBe(WORKFLOW_INTERRUPTED);
  });

  it('leaves a fresh, paused or timestamp-less run untouched', async () => {
    const store = new FakeStore();
    const fresh = seed(store, run({ id: 'wf_fresh', heartbeat_at: ago(WORKFLOW_STALE_AFTER_MS - MINUTE) }));
    const paused = seed(store, run({ id: 'wf_paused', status: 'paused_for_review', started_at: ago(48 * 60 * MINUTE) }));
    const legacyPending = seed(store, run({ id: 'wf_legacy', status: 'pending', started_at: undefined }));
    for (const wf of [fresh, paused, legacyPending]) {
      expect(await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(wf.id), wf, NOW)).toBe(wf);
    }
    expect(store.writes).toHaveLength(0);
  });

  it('closes a pending run that never started', async () => {
    const store = new FakeStore();
    const wf = seed(store, run({ status: 'pending', started_at: undefined, current_step: undefined, created_at: ago(30 * MINUTE) }));
    const closed = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(wf.id), wf, NOW);
    expect(closed).toMatchObject({ status: 'failed', failure_code: WORKFLOW_INTERRUPTED });
    expect(closed.failure_reason).toMatch(/never started/);
  });

  it('lets a completion that lands concurrently win', async () => {
    const store = new FakeStore();
    const stale = seed(store, run({ heartbeat_at: ago(WORKFLOW_STALE_AFTER_MS + MINUTE) }));
    store.beforeConditional = (path) => {
      store.docs.set(path, { ...store.docs.get(path), status: 'completed', completed_at: new Date(NOW).toISOString() });
    };
    const result = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(stale.id), stale, NOW);
    expect(result.status).toBe('completed');
    expect(result.failure_code).toBeUndefined();
    expect(store.docs.get(wfPath(stale.id))).toMatchObject({ status: 'completed' });
    expect(store.docs.get(wfPath(stale.id))?.failure_code).toBeUndefined();
  });

  it('lets a heartbeat that lands concurrently win', async () => {
    const store = new FakeStore();
    const stale = seed(store, run({ heartbeat_at: ago(WORKFLOW_STALE_AFTER_MS + MINUTE) }));
    store.beforeConditional = (path) => {
      store.docs.set(path, { ...store.docs.get(path), heartbeat_at: new Date(NOW).toISOString() });
    };
    const result = await settleInterruptedRun(store as unknown as ReadWriteStore, wfPath(stale.id), stale, NOW);
    expect(result.status).toBe('running');
    expect(isInterrupted(result, NOW)).toBe(false);
  });

  it('closes stale runs through get_workflow and list_workflows reads', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const store = new FakeStore();
    fake.store = store;
    seed(store, run({ id: 'wf_stale', heartbeat_at: ago(WORKFLOW_STALE_AFTER_MS + MINUTE) }));
    seed(store, run({ id: 'wf_live', heartbeat_at: ago(MINUTE) }));
    seed(store, run({ id: 'wf_other_site', site_id: 'other', heartbeat_at: ago(60 * MINUTE) }));

    expect((await readSiteWorkflow(ORG, SITE, 'wf_stale'))?.failure_code).toBe(WORKFLOW_INTERRUPTED);
    const listed = await listSiteWorkflows(ORG, SITE);
    expect(Object.fromEntries(listed.map((wf) => [wf.id, wf.status]))).toEqual({ wf_stale: 'failed', wf_live: 'running' });
    // Another site's run is neither returned nor touched.
    expect(store.docs.get(wfPath('wf_other_site'))?.status).toBe('running');
  });
});

describe('heartbeat from the engine', () => {
  function engineWith(store: FakeStore, clock: { t: number }) {
    return new WorkflowEngine(store as unknown as ReadWriteStore, { now: () => clock.t });
  }
  const heartbeats = (store: FakeStore, path: string) =>
    store.writes.filter((w) => w.path === path && w.applied && 'heartbeat_at' in w.data).map((w) => w.data.heartbeat_at as string);

  it('refreshes heartbeat_at during a long step, at most once per interval', async () => {
    const store = new FakeStore();
    const clock = { t: NOW };
    const seen: string[][] = [];
    const def: WorkflowDef = {
      type: 'url_parity', label: 'Long', description: '',
      steps: [{
        name: 'check_urls', label: 'Check',
        async run(ctx) {
          const path = `${paths.workflows(ORG)}/${ctx.workflowId}`;
          for (let done = 1; done <= 40; done++) {
            clock.t += 2_000; // 2 s per URL: 80 s in all
            ctx.setProgress({ total: 40, completed: done });
            await Promise.resolve();
          }
          seen.push(heartbeats(store, path));
          return { results: { checked: 40 } };
        },
      }],
    };
    const engine = engineWith(store, clock);
    const id = await engine.create({ orgId: ORG, siteId: SITE, def, triggeredBy: 'manual', createdBy: 'person' });
    const done = await engine.start(ORG, id, def);

    expect(done.status).toBe('completed');
    // Before the step: start and step entry. During it: one beat per 30 s of
    // the 80 s it took (at 30 s and 60 s), not one per progress report.
    const during = seen[0]!.slice(2);
    expect(during).toEqual([new Date(NOW + WORKFLOW_HEARTBEAT_INTERVAL_MS).toISOString(), new Date(NOW + 2 * WORKFLOW_HEARTBEAT_INTERVAL_MS).toISOString()]);
    expect(done.heartbeat_at).toBe(new Date(NOW + 80_000).toISOString());
    expect(done.progress).toEqual({ total: 1, completed: 1 });
  });

  it('does not overwrite a run that was closed or cancelled while its step ran', async () => {
    const store = new FakeStore();
    const clock = { t: NOW };
    const def: WorkflowDef = {
      type: 'url_parity', label: 'Long', description: '',
      steps: [
        {
          name: 'check_urls', label: 'Check',
          async run(ctx) {
            await cancelRun(store as unknown as ReadWriteStore, `${paths.workflows(ORG)}/${ctx.workflowId}`, 'person', clock.t);
            return { results: { checked: 630 } };
          },
        },
        { name: 'review', label: 'Review', async run() { throw new Error('must not run'); } },
      ],
    };
    const engine = engineWith(store, clock);
    const id = await engine.create({ orgId: ORG, siteId: SITE, def, triggeredBy: 'manual', createdBy: 'person' });
    const result = await engine.start(ORG, id, def);

    expect(result.status).toBe('cancelled');
    expect(result.results).toEqual({});
    expect(result.log?.at(-1)).toBe('[check_urls] cancelled by person');
  });

  it('a resumed run gets a fresh heartbeat, and a racing second approval does not run it twice', async () => {
    const store = new FakeStore();
    const clock = { t: NOW - 48 * 60 * MINUTE };
    const def: WorkflowDef = {
      type: 'url_parity', label: 'Gate', description: '',
      steps: [
        { name: 'review', label: 'Review', async run() { return { __review: true as const, message: 'Look' }; } },
        { name: 'after', label: 'After', async run() { return {}; } },
      ],
    };
    const engine = engineWith(store, clock);
    const id = await engine.create({ orgId: ORG, siteId: SITE, def, triggeredBy: 'manual', createdBy: 'person' });
    expect((await engine.start(ORG, id, def)).status).toBe('paused_for_review');
    clock.t = NOW;
    // A second approval racing the first does not start the remaining steps twice.
    await Promise.all([engine.resume(ORG, id, def), engine.resume(ORG, id, def)]);
    const final = (await store.getDoc<WorkflowRecord>(wfPath(id)))!;
    expect(final.status).toBe('completed');
    expect(isInterrupted(final, NOW)).toBe(false);
    expect(final.heartbeat_at).toBe(new Date(NOW).toISOString());
    expect(store.writes.filter((w) => w.applied && w.data.status === 'running' && 'review_message' in w.data)).toHaveLength(1);
  });
});

describe('cancelling a run', () => {
  it('records a running or paused run as cancelled and refuses a finished one', async () => {
    const store = new FakeStore();
    const s = store as unknown as ReadWriteStore;
    seed(store, run({ id: 'wf_run', heartbeat_at: ago(MINUTE) }));
    seed(store, run({ id: 'wf_paused', status: 'paused_for_review' }));
    seed(store, run({ id: 'wf_done', status: 'completed' }));

    expect(await cancelRun(s, wfPath('wf_run'), 'person', NOW)).toMatchObject({ status: 'cancelled', cancelled_by: 'person', cancelled_at: new Date(NOW).toISOString() });
    expect((await cancelRun(s, wfPath('wf_paused'), 'person', NOW))?.status).toBe('cancelled');
    expect(await cancelRun(s, wfPath('wf_done'), 'person', NOW)).toBeNull();
    expect(store.docs.get(wfPath('wf_done'))?.status).toBe('completed');
  });

  it('needs the permission that starting the type needs, and 409s a finished run', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const store = new FakeStore();
    fake.store = store;
    seed(store, run({ id: 'wf_deploy', type: 'rebuild_deploy', heartbeat_at: ago(MINUTE) }));
    seed(store, run({ id: 'wf_parity', heartbeat_at: ago(MINUTE) }));
    seed(store, run({ id: 'wf_stale', heartbeat_at: ago(60 * MINUTE) }));
    const cancel = (workflowId: string, permission: 'read' | 'write' | 'admin') =>
      cancelSiteWorkflow({ orgId: ORG, siteId: SITE, workflowId, permission, cancelledBy: 'person' });

    await expect(cancel('wf_parity', 'read')).rejects.toMatchObject({ status: 403 });
    await expect(cancel('wf_deploy', 'write')).rejects.toMatchObject({ status: 403 });
    expect((await cancel('wf_deploy', 'admin')).status).toBe('cancelled');
    expect((await cancel('wf_parity', 'write')).status).toBe('cancelled');
    await expect(cancel('wf_parity', 'write')).rejects.toMatchObject({ status: 409 });
    // A stale run is closed as interrupted on the way in, so it is finished.
    const stale = cancel('wf_stale', 'write');
    await expect(stale).rejects.toBeInstanceOf(WorkflowRequestError);
    await expect(stale).rejects.toMatchObject({ status: 409 });
    expect(store.docs.get(wfPath('wf_stale'))?.failure_code).toBe(WORKFLOW_INTERRUPTED);
    await expect(cancel('wf_missing', 'admin')).rejects.toMatchObject({ status: 404 });
  });
});
