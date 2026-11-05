// `redirect: 'error'` semantics on every runtime. Workers implements only
// `follow` and `manual` and throws a TypeError for `error`, so server code
// asks for `manual` and refuses a redirect here, as Node would.

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() that rejects instead of following a redirect. `fetchImpl` is
 * resolved per call, so a fetch replaced later (tests) is used.
 * @param {typeof fetch} [fetchImpl]
 * @returns {typeof fetch}
 */
export function withoutRedirects(fetchImpl) {
  return async (input, init = {}) => {
    const response = await (fetchImpl ?? globalThis.fetch)(input, { ...init, redirect: 'manual' });
    if (response.type === 'opaqueredirect' || REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('fetch failed: the server answered with a redirect, which is not followed');
    }
    return response;
  };
}
