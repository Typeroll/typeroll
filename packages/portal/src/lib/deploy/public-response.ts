import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { createSafeFetch } from '../net/safe-fetch';

interface Options { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination }
// The early check classifies a missing host (ENOTFOUND) for callers; the
// guarded fetch checks every address again before the request. Redirects are
// returned to the caller, which keeps them on the same origin.
//
// Name resolution is DNS over HTTPS on Workers (`node:dns` resolves through
// 1.1.1.1), so a host created minutes ago is not hidden by a process-local
// negative cache and no separate public-DNS fallback is needed.
const publicationFetch = createSafeFetch({ label: 'Publication URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 32 * 1024 * 1024 });
export const missingDns = (error: unknown) => {
  const value = error as { code?: string; cause?: { code?: string } };
  return (value?.cause?.code ?? value?.code) === 'ENOTFOUND';
};

/** One read-only request to a public HTTPS publication URL, without following redirects. */
export async function publicationResponse(url: URL, init: RequestInit, options: Options = {}) {
  parsePublicHttpsUrl(url.href);
  if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) throw Error('Publication checks must be read-only');
  let response: Response | undefined;
  const close = async () => {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  };
  try {
    await (options.validate ?? assertPublicDestination)(url);
    response = await (options.fetchImpl ?? publicationFetch)(url, { ...init, redirect: 'manual' });
    return { response, close };
  } catch (error) { await close(); throw error; }
}
