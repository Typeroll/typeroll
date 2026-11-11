// Polite reading of a customer's old website during a migration.
//
// Old hosts, and the CDNs and WAFs in front of them, throttle or block a
// client that requests quickly. Every migration fetcher therefore backs off
// when the host says so: HTTP 429 and 503 are retried after `Retry-After`
// (seconds or an HTTP date) when the host sends one, otherwise after an
// exponential delay with jitter. Waits are capped and retries bounded, so a
// host that keeps refusing ends in its last response instead of a stalled
// job. Sequential loops also keep a small gap between requests to one host.
//
// The helper wraps a request function, so each attempt keeps the caller's
// transport, timeout and size limits unchanged. Delays are injectable
// (`sleep`, `random`, `now`) so tests run instantly.

/** Statuses a host uses to say "slow down" or "try again later". */
export const POLITE_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export interface PoliteRetryOptions {
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff delay without `Retry-After`, doubled per retry. Default 1 s. */
  baseDelayMs?: number;
  /** Cap on any single wait, `Retry-After` included. Default 30 s. */
  maxDelayMs?: number;
  /** Statuses to retry. Default 429 and 503. */
  statuses?: ReadonlySet<number>;
  /** No wait may end after this epoch time in ms; the last response is returned instead. */
  deadlineAt?: number;
  /** Stops waiting (and retrying) when aborted. */
  signal?: AbortSignal;
  /** Called before each wait, for logs and tests. */
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Uniform [0, 1) source for jitter. */
  random?: () => number;
  now?: () => number;
}

/** Retry options plus the gap a sequential loop keeps between requests. */
export interface PoliteOptions extends PoliteRetryOptions {
  /** Minimum gap in ms between consecutive requests of one loop. Default 250. */
  paceMs?: number;
}

export const POLITE_DEFAULTS = {
  retries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  /** Gap between consecutive requests of one sequential loop to one host. */
  paceMs: 250,
} as const;

/** setTimeout-based sleep that ends early when the signal aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * The wait a `Retry-After` header asks for, in ms: delta seconds or an HTTP
 * date. Null when absent or unreadable; a date in the past is 0.
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Delay before retry `attempt` (1-based): the host's `Retry-After` when it
 * sent one, otherwise full-jitter exponential backoff (a random wait up to
 * base·2^(attempt-1), never under half of it). Always capped.
 */
export function politeDelayMs(attempt: number, retryAfter: string | null | undefined, options: PoliteRetryOptions = {}): number {
  const maxDelay = options.maxDelayMs ?? POLITE_DEFAULTS.maxDelayMs;
  const asked = retryAfterMs(retryAfter, (options.now ?? Date.now)());
  if (asked !== null) return Math.min(asked, maxDelay);
  const ceiling = Math.min(maxDelay, (options.baseDelayMs ?? POLITE_DEFAULTS.baseDelayMs) * 2 ** Math.max(0, attempt - 1));
  const random = options.random ?? Math.random;
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

/**
 * Run `request` and retry it while the host answers 429 or 503, waiting as
 * the host asks. Returns the first other response, or the last refusal once
 * the retries, the deadline or the signal end the attempts. A refused
 * response's body is released before the next attempt. Errors (timeouts,
 * network) propagate unchanged: retrying those is the caller's decision.
 */
export async function politeFetch(request: () => Promise<Response>, options: PoliteRetryOptions = {}): Promise<Response> {
  const retries = Math.max(0, options.retries ?? POLITE_DEFAULTS.retries);
  const statuses = options.statuses ?? POLITE_RETRY_STATUSES;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  for (let attempt = 1; ; attempt++) {
    const response = await request();
    if (!statuses.has(response.status) || attempt > retries || options.signal?.aborted) return response;
    const delayMs = politeDelayMs(attempt, response.headers.get('retry-after'), options);
    if (options.deadlineAt !== undefined && now() + delayMs > options.deadlineAt) return response;
    void response.body?.cancel().catch(() => {});
    options.onRetry?.({ attempt, status: response.status, delayMs });
    await sleep(delayMs, options.signal);
    if (options.signal?.aborted) {
      // The caller gave up while waiting: answer with the refusal it would have seen.
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  }
}

/** A fetch-compatible function that retries refusals politely. */
export function politeFetchImpl(fetchImpl: typeof fetch, options: PoliteRetryOptions = {}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => politeFetch(() => fetchImpl(input, init), {
    ...options,
    ...(options.signal || !init?.signal ? {} : { signal: init.signal }),
  })) as typeof fetch;
}

/**
 * Keeps consecutive requests of one sequential loop at least `intervalMs`
 * apart. The first request starts at once. Meant for one loop at a time:
 * concurrent callers are not queued.
 */
export class RequestPacer {
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number = POLITE_DEFAULTS.paceMs,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  static for(options: PoliteOptions = {}): RequestPacer {
    return new RequestPacer(options.paceMs ?? POLITE_DEFAULTS.paceMs, options.sleep ?? defaultSleep, options.now ?? Date.now);
  }

  async wait(): Promise<void> {
    const remaining = this.last + this.intervalMs - this.now();
    if (remaining > 0) await this.sleep(remaining);
    this.last = this.now();
  }
}
