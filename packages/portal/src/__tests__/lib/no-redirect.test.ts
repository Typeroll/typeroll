// Workers implements only `follow` and `manual`: `redirect: 'error'` throws a
// TypeError there before any request is sent. Server code refuses redirects
// through withoutRedirects instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withoutRedirects } from '../../lib/net/no-redirect.mjs';

const SRC = path.resolve(__dirname, '../..');
// Not server code: the build engine runs in Node in the organization's account
// and is frozen with its publication; the native admin client and the editor
// runtime script run in the browser.
const OUTSIDE_THE_WORKER = [/^lib\/builds\/(direct-upload|executor|github-runner|github-sandbox)\.mjs$/, /^lib\/extensions\/(native-admin-client|editor-runtime)\.ts$/];
// safeFetch implements `redirect: 'error'` itself over manual hops.
const refusesRedirects = (line: string) => /redirect:\s*['"]error['"]/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !line.includes('safeFetch(');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    return statSync(file).isDirectory() ? walk(file) : /\.(m?[jt]s|astro)$/.test(name) ? [file] : [];
  });
}

describe('withoutRedirects', () => {
  it('asks for manual redirects and rejects a redirect answer', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } });
    });
    await expect(withoutRedirects(fetchImpl as typeof fetch)('https://api.example/', { method: 'POST', redirect: 'error' })).rejects.toThrow(TypeError);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/', expect.objectContaining({ method: 'POST', redirect: 'manual' }));
  });

  it('returns every other answer unchanged, including errors and 304', async () => {
    for (const status of [200, 304, 401, 503]) {
      const response = await withoutRedirects(async () => new Response(status === 304 ? null : 'x', { status }))('https://api.example/');
      expect(response.status).toBe(status);
    }
  });

  it('uses the global fetch at call time when none is given', async () => {
    const replaced = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', replaced);
    try {
      expect(await (await withoutRedirects()('https://api.example/')).text()).toBe('ok');
      expect(replaced).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is the only way server code refuses redirects', () => {
    const offenders = walk(SRC)
      .map(file => path.relative(SRC, file).split(path.sep).join('/'))
      .filter(file => !OUTSIDE_THE_WORKER.some(pattern => pattern.test(file)))
      .filter(file => readFileSync(path.join(SRC, file), 'utf8').split('\n').some(refusesRedirects));
    expect(offenders).toEqual([]);
  });
});
