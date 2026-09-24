import { expect, it, vi } from 'vitest';
import { BWRAP_URL, sandboxBinary } from '../../lib/builds/executor.mjs';
import { sha256 } from '../../lib/builds/contract.mjs';
import { acquireGithubBubblewrap, assertGithubBootstrapEnvironment } from '../../lib/builds/github-sandbox.mjs';

function disk(change: Record<string, unknown> = {}, bytes = 'pinned binary') {
  return { lstat: vi.fn(async (name: string) => ({ uid: 0, mode: 0o755, isSymbolicLink: () => false, isFile: () => name.endsWith('bwrap'), isDirectory: () => !name.endsWith('bwrap'), ...(name === '/usr/bin/bwrap' ? change : {}) })), readFile: vi.fn(async (name: string) => Buffer.from(name === '/usr/bin/bwrap' ? bytes : 'pinned binary')) };
}
it('selects only a root-owned non-writable system binary identical to the verified archive', async () => {
  expect(await sandboxBinary('/extracted/bwrap', disk())).toBe('/usr/bin/bwrap');
  for (const change of [{ uid: 1001 }, { mode: 0o777 }, { mode: 0o4755 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    expect(await sandboxBinary('/extracted/bwrap', disk(change))).toBe('/extracted/bwrap');
  }
  expect(await sandboxBinary('/extracted/bwrap', disk({}, 'different release'))).toBe('/extracted/bwrap');
  const absent = disk(); absent.lstat.mockRejectedValue(Error('not installed'));
  expect(await sandboxBinary('/extracted/bwrap', absent)).toBe('/extracted/bwrap');
});
it('rejects a writable parent even if the installed binary itself is trusted', async () => {
  const files = disk(); const normal = files.lstat.getMockImplementation()!;
  files.lstat.mockImplementation(async name => name === '/usr/bin' ? { ...await normal(name), mode: 0o777 } : normal(name));
  expect(await sandboxBinary('/extracted/bwrap', files)).toBe('/extracted/bwrap');
});
it('limits privileged bootstrap to explicitly identified ephemeral GitHub Linux runners', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
  expect(() => assertGithubBootstrapEnvironment(env, 'linux', 'x64', 0)).not.toThrow();
  for (const args of [[{}, 'linux', 'x64', 0], [env, 'darwin', 'x64', 0], [env, 'linux', 'arm64', 0], [env, 'linux', 'x64', 1001], [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 'x64', 0]]) {
    expect(() => assertGithubBootstrapEnvironment(...args)).toThrow('github_hosted_bootstrap_required');
  }
});

// A pinned package version can disappear from Ubuntu's rolling package pool.
it('loads bubblewrap through the shared fallback and keeps a bad digest from falling through', async () => {
  const sources = ['https://upstream.example/bwrap.deb', 'https://mirror.example/bwrap.deb'];
  const body = Buffer.from('pinned sandbox');
  const pinned = sha256(body);
  const quiet = () => {};
  const urlOf = (input: RequestInfo | URL) => input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  const fetchAt = (respond: (url: string) => Response) => async (input: RequestInfo | URL, _init?: RequestInit) => respond(urlOf(input));
  await expect(acquireGithubBubblewrap(fetchAt(url => (
    url === sources[0] ? new Response('', { status: 503 }) : new Response(body)
  )), sources, pinned, quiet)).resolves.toEqual(body);
  await expect(acquireGithubBubblewrap(fetchAt(() => new Response('', { status: 503 })), sources, pinned, quiet)).rejects.toThrow('github_sandbox_unavailable');
  let mirrorFetches = 0;
  await expect(acquireGithubBubblewrap(fetchAt(url => {
    if (url === sources[1]) mirrorFetches += 1;
    return url === sources[0] ? new Response('substituted') : new Response(body);
  }), sources, pinned, quiet)).rejects.toThrow('github_sandbox_integrity_failed');
  expect(mirrorFetches).toBe(0);
});
it('pins the sandbox archive to a dated official Ubuntu snapshot', () => {
  const url = new URL(BWRAP_URL);
  expect(url.origin).toBe('https://snapshot.ubuntu.com');
  expect(url.pathname).toMatch(/^\/ubuntu\/\d{8}T\d{6}Z\/pool\/main\/b\/bubblewrap\/bubblewrap_[^/]+_amd64\.deb$/);
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
});
