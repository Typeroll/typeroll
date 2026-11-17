import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { StoreTransport } from '../store/sql-store';

// Fixed labels only: never put paths, IDs, payloads or credentials in telemetry.
type Step = 'preview_route' | 'preview_inputs' | 'preview_render' | 'preview_media' | 'preview_fonts' | 'preview_derivation' | 'schema' | 'authentication' | 'read_page' | 'readback' | 'request_body'
  | 'content_write' | 'content_validation' | 'draft_write' | 'commit'
  | 'revision' | 'page_write' | 'response'
  | 'store_get' | 'store_getMany' | 'store_list' | 'store_commit'
  | 'store_deleteTree' | 'store_sequence' | 'store_changedSince' | 'store_paths';
type Metric = { count: number; ms: number; max_ms: number };
interface Trace {
  now: () => number; start: number; id: string; authorized: boolean; closed: boolean;
  steps: Partial<Record<Step, Metric>>; storeActive: number; storeStart: number;
  storeBusy: number; storeCalls: number; conflicts: number;
}
const timing = new AsyncLocalStorage<Trace | undefined>();

export function authorizeRequestTiming(): void {
  const trace = timing.getStore();
  if (trace) trace.authorized = true;
}

/** Detached maintenance/audit must not be counted as awaited request work. */
export function withoutRequestTiming<T>(work: () => T): T { return timing.run(undefined, work); }

function startStep(name: Step): (() => void) | undefined {
  const trace = timing.getStore();
  if (!trace || trace.closed) return;
  const start = trace.now();
  const storage = name.startsWith('store_');
  if (storage) {
    trace.storeCalls++;
    if (trace.storeActive++ === 0) trace.storeStart = start;
  }
  return () => {
    if (trace.closed) return;
    const end = trace.now();
    const ms = Math.max(0, end - start);
    const metric = trace.steps[name] ??= { count: 0, ms: 0, max_ms: 0 };
    metric.count++; metric.ms += ms; metric.max_ms = Math.max(metric.max_ms, ms);
    if (storage && --trace.storeActive === 0) trace.storeBusy += Math.max(0, end - trace.storeStart);
  };
}

export async function measureRequestStep<T>(name: Step, work: () => Promise<T>): Promise<T> {
  const finish = startStep(name);
  try { return await work(); } finally { finish?.(); }
}

export function measureRequestSync<T>(name: Step, work: () => T): T {
  const finish = startStep(name);
  try { return work(); } finally { finish?.(); }
}

export function recordStoreConflict(): void {
  const trace = timing.getStore();
  if (trace && !trace.closed) trace.conflicts++;
}

/** Instrument the caller's RPC transport, leaving the SQL object runtime-neutral. */
export function timedStoreTransport(transport: StoreTransport): StoreTransport {
  return {
    get: path => measureRequestStep('store_get', () => transport.get(path)),
    getMany: paths => measureRequestStep('store_getMany', () => transport.getMany(paths)),
    list: (collection, opts) => measureRequestStep('store_list', () => transport.list(collection, opts)),
    commit: (preconditions, writes) => measureRequestStep('store_commit', async () => {
      const result = await transport.commit(preconditions, writes);
      if (!result.ok) recordStoreConflict();
      return result;
    }),
    deleteTree: path => measureRequestStep('store_deleteTree', () => transport.deleteTree(path)),
    sequence: () => measureRequestStep('store_sequence', () => transport.sequence()),
    changedSince: (seq, root) => measureRequestStep('store_changedSince', () => transport.changedSince(seq, root)),
    ...(transport.paths ? { paths: (after?: string, limit?: number) => measureRequestStep('store_paths', () => transport.paths!(after, limit)) } : {}),
  };
}

function pageOperation(request: Request): string | null {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET') {
    if (/^\/preview\/[^/]+(?:\/|$)/.test(path)) return 'preview.shared';
    if (/^\/api\/sites\/[^/]+\/preview\//.test(path)) return 'preview.site';
    if (/^\/api\/v1\/sites\/[^/]+\/pages\/[^/]+\/preview$/.test(path)) return 'preview.api';
  }
  const match = path.match(/^\/api\/v1\/sites\/[^/]+\/pages\/([^/]+)$/);
  if (!match) return null;
  if (request.method === 'POST' && ['batch-read', 'batch-write'].includes(match[1]!)) return `pages.${match[1]}`;
  return ['GET', 'PATCH', 'PUT'].includes(request.method) ? `pages.${request.method.toLowerCase()}` : null;
}

/** Outer middleware timing, before auth/schema checks; no timing data for refused authentication. */
export async function withApiRequestTiming(request: Request, work: () => Promise<Response>, options: {
  now?: () => number; log?: (report: Record<string, unknown>) => void;
} = {}): Promise<Response> {
  const operation = pageOperation(request);
  if (!operation || timing.getStore()) return work();
  const now = options.now ?? (() => performance.now());
  const trace: Trace = { now, start: now(), id: randomUUID(), authorized: false, closed: false,
    steps: {}, storeActive: 0, storeStart: 0, storeBusy: 0, storeCalls: 0, conflicts: 0 };
  return timing.run(trace, async () => {
    let response: Response | undefined;
    try {
      const result = await work();
      response = trace.authorized ? new Response(result.body, result) : result;
      return response;
    }
    finally {
      const end = now();
      const elapsed = Math.max(0, end - trace.start);
      trace.closed = true;
      if (trace.authorized) {
        const round = (value: number) => Math.round(value * 10) / 10;
        const storeBusy = trace.storeBusy + (trace.storeActive ? Math.max(0, end - trace.storeStart) : 0);
        const steps = Object.fromEntries(Object.entries(trace.steps).map(([name, metric]) => [name, {
          count: metric.count, ms: round(metric.ms), max_ms: round(metric.max_ms),
        }]));
        // The response copy has mutable headers; its body is never read by telemetry.
        if (response) {
          const values = [`total;dur=${round(elapsed)}`, `store_busy;dur=${round(storeBusy)}`,
            ...Object.entries(steps).map(([name, metric]) => `${name};dur=${metric.ms};desc="${metric.count} calls"`)];
          response.headers.set('Server-Timing', values.join(', '));
          response.headers.set('X-Typeroll-Timing-Id', trace.id);
        }
        if (elapsed >= 1000 || options.log) (options.log ?? (report => console.info(JSON.stringify(report))))({
          event: 'page_api_timing', timing_id: trace.id, operation, status: response?.status ?? 500,
          total_ms: round(elapsed), store_busy_ms: round(storeBusy), store_calls: trace.storeCalls,
          store_conflicts: trace.conflicts, steps,
        });
      }
    }
  });
}
