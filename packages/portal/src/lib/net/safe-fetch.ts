// Guarded outbound HTTP for URLs that customers, API keys or remote content
// choose (WordPress sources, links, webhooks, diagnostics).
//
// One request = one policy:
//   - only http(s) URLs without credentials; plain http only when the caller
//     opts in (WordPress sources are often http);
//   - every destination, including each redirect hop and IP literals, must be
//     a public address (see `classifyIpAddress` in @typeroll/shared);
//   - the TCP connection is pinned to the addresses that were validated: DNS
//     resolution happens inside the connection's own lookup, so a rebinding
//     answer cannot slip in between check and connect;
//   - redirects are followed manually with a hop limit, and credentials or
//     custom headers are dropped when a hop leaves the origin;
//   - a deadline covers headers and body, and the body is byte-capped while it
//     streams.
//
// Self-hosted operators can migrate an intranet WordPress by setting
// TYPEROLL_ALLOW_PRIVATE_NETWORK_FETCH=1. That relaxes private, loopback and
// shared ranges for requests whose policy asks for it (migration only).
// Link-local (cloud metadata), multicast and reserved ranges stay blocked.

import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { classifyIpAddress, isIpAddressLiteral, isLocalHostname, type IpAddressClass } from '@typeroll/shared';

export const PRIVATE_NETWORK_FETCH_ENV = 'TYPEROLL_ALLOW_PRIVATE_NETWORK_FETCH';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'accept-encoding']);
const OPT_IN_CLASSES = new Set<IpAddressClass>(['private', 'loopback', 'shared']);

export type OutboundErrorCode =
  | 'invalid_url'
  | 'blocked_destination'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'redirect_not_allowed'
  | 'response_too_large'
  | 'invalid_response';

export class OutboundRequestError extends Error {
  constructor(readonly code: OutboundErrorCode, message: string) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

export interface OutboundPolicy {
  /** Allow plain http:// (default: HTTPS only). */
  allowHttp?: boolean;
  /** `self_hosted_opt_in` honours TYPEROLL_ALLOW_PRIVATE_NETWORK_FETCH. Default `deny`. */
  privateNetwork?: 'deny' | 'self_hosted_opt_in';
  /** Redirect hops followed when the request uses redirect: 'follow' (default 5). */
  maxRedirects?: number;
  /** Deadline for the whole exchange, body included (default 15 s). */
  timeoutMs?: number;
  /** Response body cap in bytes (default 10 MiB). */
  maxBytes?: number;
  /** Prefix for error messages, e.g. 'WordPress URL'. */
  label?: string;
  /**
   * Whether a redirect hop may keep all request headers. Default: same origin.
   * Other hops keep only User-Agent and Accept headers.
   */
  keepHeadersOnRedirect?: (from: URL, to: URL) => boolean;
}

/** Whether this process lets migration fetches reach private networks. */
export function privateNetworkFetchAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes)$/i.test(String(env[PRIVATE_NETWORK_FETCH_ENV] ?? '').trim());
}

function privateAllowed(policy: OutboundPolicy): boolean {
  return policy.privateNetwork === 'self_hosted_opt_in' && privateNetworkFetchAllowed();
}

/** True when `address` may be contacted under `policy`. */
export function isAllowedOutboundAddress(address: string, policy: OutboundPolicy = {}): boolean {
  const kind = classifyIpAddress(address);
  return kind === 'public' || (OPT_IN_CLASSES.has(kind) && privateAllowed(policy));
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Synchronous URL checks: scheme, credentials, local names and IP literals.
 * Host names are resolved and checked again when the connection is made.
 */
export function parseOutboundUrl(raw: string | URL, policy: OutboundPolicy = {}): URL {
  const label = policy.label ?? 'URL';
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new OutboundRequestError('invalid_url', `${label} is invalid`); }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new OutboundRequestError('invalid_url', policy.allowHttp ? `${label} must use http or https` : `${label} must use HTTPS`);
  }
  if (url.username || url.password) throw new OutboundRequestError('invalid_url', `${label} must not contain credentials`);
  const host = url.hostname.toLowerCase();
  if (!host) throw new OutboundRequestError('invalid_url', `${label} is invalid`);
  if (isIpAddressLiteral(host)) {
    if (!isAllowedOutboundAddress(host, policy)) throw new OutboundRequestError('blocked_destination', `${label} must use a public host`);
  } else if (isLocalHostname(host) && !privateAllowed(policy)) {
    throw new OutboundRequestError('blocked_destination', `${label} must use a public host`);
  }
  return url;
}

type LookupFn = (hostname: string, options: dns.LookupAllOptions) => Promise<LookupAddress[]>;
const systemLookup: LookupFn = (hostname, options) => dns.promises.lookup(hostname, options);

/** Resolve a host and require every answer to be allowed. Used for checks that do not connect. */
export async function resolveOutboundAddresses(hostname: string, policy: OutboundPolicy = {}, lookup: LookupFn = systemLookup): Promise<LookupAddress[]> {
  const host = bareHost(hostname);
  if (isIpAddressLiteral(host)) {
    if (!isAllowedOutboundAddress(host, policy)) throw new OutboundRequestError('blocked_destination', 'Destination is not a public address');
    return [{ address: host, family: host.includes(':') ? 6 : 4 }];
  }
  let addresses: LookupAddress[];
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new OutboundRequestError('dns_failed', 'Destination host could not be resolved'); }
  if (!addresses.length) throw new OutboundRequestError('dns_failed', 'Destination host could not be resolved');
  if (addresses.some((entry) => !isAllowedOutboundAddress(entry.address, policy))) {
    throw new OutboundRequestError('blocked_destination', 'Destination resolved to a non-public address');
  }
  return addresses;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * The `connect.lookup` of the pinned agents: the socket connects only to the
 * addresses this function validated, in the same resolution.
 */
export function createValidatingLookup(policy: OutboundPolicy, lookup: LookupFn = systemLookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolveOutboundAddresses(hostname, policy, lookup).then((addresses) => {
      const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
      const matching = family ? addresses.filter((entry) => entry.family === family) : addresses;
      if (!matching.length) {
        callback(Object.assign(new Error(`No IPv${family} address for ${hostname}`), { code: 'ENOTFOUND' }), '', family || 4);
        return;
      }
      if (options?.all) callback(null, matching);
      else callback(null, matching[0]!.address, matching[0]!.family);
    }, (error: Error) => callback(Object.assign(error, { code: (error as { code?: string }).code ?? 'EBLOCKED' }), '', 4));
  };
}

const agents = new Map<string, Agent>();
function pinnedAgent(policy: OutboundPolicy): Agent {
  const key = privateAllowed(policy) ? 'private' : 'public';
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { timeout: 10_000, lookup: createValidatingLookup({ privateNetwork: key === 'private' ? 'self_hosted_opt_in' : 'deny' }) as never },
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });
    agents.set(key, agent);
  }
  return agent;
}

// A replaced global fetch (tests, local instrumentation) owns connection
// establishment; URL, redirect, deadline and size checks still apply.
const NATIVE_FETCH = globalThis.fetch;
function replacedFetch(): typeof fetch | null {
  const current = globalThis.fetch;
  return current !== NATIVE_FETCH || 'mock' in current ? current : null;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function capBody(response: Response, maxBytes: number, label: string): ReadableStream<Uint8Array> | null {
  if (!response.body) return null;
  let total = 0;
  return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new OutboundRequestError('response_too_large', `${label} response exceeds ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

function finalResponse(response: Response, url: URL, redirected: boolean, maxBytes: number, label: string): Response {
  // Only stream-bodied responses are re-wrapped; a bare test double passes through.
  if (typeof response.headers?.get !== 'function' || (response.body != null && !(response.body instanceof ReadableStream))) return response;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new OutboundRequestError('response_too_large', `${label} response exceeds ${maxBytes} bytes`);
  }
  const body = NULL_BODY_STATUSES.has(response.status) ? null : capBody(response, maxBytes, label);
  let wrapped: Response;
  try {
    wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    void body?.cancel().catch(() => {});
    throw new OutboundRequestError('invalid_response', `${label} returned an unsupported HTTP status ${response.status}`);
  }
  Object.defineProperty(wrapped, 'url', { value: url.href });
  Object.defineProperty(wrapped, 'redirected', { value: redirected });
  return wrapped;
}

/**
 * fetch() with the outbound policy applied. `init.redirect` keeps its meaning:
 * 'follow' (default) follows validated hops, 'manual' returns the 3xx response
 * and 'error' rejects on a redirect.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, policy: OutboundPolicy = {}): Promise<Response> {
  const label = policy.label ?? 'URL';
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = AbortSignal.timeout(policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const mode = init.redirect ?? 'follow';
  let url = parseOutboundUrl(input, policy);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers: HeadersInit | undefined = init.headers;
  let redirected = false;

  for (let hop = 0; ; hop++) {
    const request: RequestInit = { ...init, method, body, headers, redirect: 'manual', signal };
    const replaced = replacedFetch();
    const response = replaced
      ? await replaced(hop === 0 ? input : url, request)
      : await undiciFetch(url, { ...request, headers: headerRecord(headers), dispatcher: pinnedAgent(policy) } as never) as unknown as Response;

    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (!location || mode === 'manual') return finalResponse(response, url, redirected, maxBytes, label);
    void response.body?.cancel().catch(() => {});
    if (mode === 'error') throw new OutboundRequestError('redirect_not_allowed', `${label} redirected`);
    if (hop >= maxRedirects) throw new OutboundRequestError('too_many_redirects', `${label} exceeded ${maxRedirects} redirects`);

    let next: URL;
    try { next = new URL(location, url); } catch { throw new OutboundRequestError('invalid_url', `${label} redirected to an invalid URL`); }
    next = parseOutboundUrl(next, { ...policy, label: `${label} redirect` });
    if (response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST') {
      method = method === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
      const kept = new Headers(headers);
      for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) kept.delete(name);
      headers = headerRecord(kept);
    }
    if (!(policy.keepHeadersOnRedirect ?? sameOrigin)(url, next)) {
      headers = Object.fromEntries([...new Headers(headers).entries()].filter(([name]) => CROSS_ORIGIN_SAFE_HEADERS.has(name)));
    }
    url = next;
    redirected = true;
  }
}

function sameOrigin(from: URL, to: URL): boolean {
  return from.origin === to.origin;
}

/** A fetch-compatible function bound to one policy, for code that takes `fetchImpl`. */
export function createSafeFetch(policy: OutboundPolicy): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' || input instanceof URL ? input : input.url;
    return safeFetch(target, init, policy);
  }) as typeof fetch;
}

/** Policy for reading a WordPress (or other) migration source. */
export function migrationSourcePolicy(overrides: OutboundPolicy = {}): OutboundPolicy {
  return {
    allowHttp: true,
    privateNetwork: 'self_hosted_opt_in',
    label: 'Source URL',
    // http -> https and www. canonicalisation stay on the source; never downgrade to http.
    keepHeadersOnRedirect: (from, to) => sameSourceSite(to, from) && !(from.protocol === 'https:' && to.protocol === 'http:'),
    ...overrides,
  };
}

/** Two URLs belong to the same source site: same host (ignoring www.), http(s), same effective port. */
export function sameSourceSite(candidate: string | URL, source: string | URL): boolean {
  try {
    const a = new URL(String(candidate));
    const b = new URL(String(source));
    const web = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:';
    if (!web(a) || !web(b) || a.username || a.password) return false;
    const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');
    const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
    const defaultPort = (url: URL) => url.port === '';
    return host(a) === host(b) && (port(a) === port(b) || (defaultPort(a) && defaultPort(b)));
  } catch {
    return false;
  }
}
