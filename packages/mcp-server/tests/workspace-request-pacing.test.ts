import { describe, it, expect } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Offline checks of the starter's polite request pacing (scripts/typeroll/pacing.py and browser.cjs).
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workspace-templates/scripts/typeroll');
const qa = createRequire(import.meta.url)(path.join(SCRIPTS, 'browser.cjs'));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const run = promisify(execFile);

async function python(code: string, env: Record<string, string> = {}) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})\n`;
  // -B keeps __pycache__ out of the shipped templates; -I ignores the caller's Python environment.
  const { stdout, stderr } = await run('python3', ['-B', '-I', '-c', prelude + code], { env: { PATH: process.env.PATH ?? '', ...env } });
  return { out: stdout.trim(), err: stderr.trim() };
}

describe('browser.cjs request profile', () => {
  it('is local by default, cloud on a clearly identified cloud runner, and explicit overrides win', () => {
    expect(qa.selectProfile({})).toMatchObject({ name: 'local', concurrency: 2, interval: 300, reason: 'default' });
    expect(qa.selectProfile({ CI: 'false' }).name).toBe('local');
    for (const marker of ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITHUB_ACTIONS', 'CI']) {
      const profile = qa.selectProfile({ [marker]: 'true' });
      expect(profile).toMatchObject({ name: 'cloud', reason: marker });
      expect(profile.concurrency).toBeGreaterThanOrEqual(4);
      expect(profile.concurrency).toBeLessThanOrEqual(6);
      expect(profile.interval).toBeLessThan(300);
    }
    expect(qa.selectProfile({ CI: 'true', TYPEROLL_REQUEST_PROFILE: 'local' })).toMatchObject({ name: 'local', reason: 'TYPEROLL_REQUEST_PROFILE' });
    expect(qa.selectProfile({ TYPEROLL_REQUEST_PROFILE: 'cloud', TYPEROLL_REQUEST_CONCURRENCY: '3' }).concurrency).toBe(3);
    expect(() => qa.selectProfile({ TYPEROLL_REQUEST_PROFILE: 'fast' })).toThrow(/local or cloud/);
    expect(() => qa.selectProfile({ TYPEROLL_REQUEST_CONCURRENCY: '0' })).toThrow(/1 to 16/);
    expect(qa.describeProfile(qa.selectProfile({}))).toMatch(/Request profile: local .*TYPEROLL_REQUEST_PROFILE=cloud/);
  });

  it('parses Retry-After and bounds the backoff', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:27:00 GMT');
    expect(qa.retryAfter('7')).toBe(7000);
    expect(qa.retryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(60000);
    expect(qa.retryAfter('Wed, 21 Oct 2026 07:00:00 GMT', now)).toBe(0);
    expect(qa.retryAfter('soon')).toBeNull();
    expect(qa.retryAfter('-1')).toBeNull();
    expect(qa.retryAfter(undefined)).toBeNull();
    expect([0, 1, 2].map(attempt => qa.retryDelay(attempt, 503))).toEqual([1000, 2000, 4000]);
    expect(qa.retryDelay(3, 503)).toBeNull();
    expect(qa.retryDelay(0, 429, '2')).toBe(2000);
    expect(qa.retryDelay(0, 429, '3600')).toBeNull(); // A long pause request stops rather than hammers.
    expect(qa.retryDelay(0, 404)).toBeNull();
    expect(qa.retryDelay(0, undefined)).toBe(1000); // Network error.
  });

  it('retries a throttled navigation after Retry-After and returns the final response', async () => {
    const statuses = [429, 503, 200];
    const calls: string[] = [];
    const page = {
      goto: async (url: string) => {
        calls.push(url);
        const status = statuses.shift();
        return { status: () => status, headers: () => ({ 'retry-after': '0' }) };
      },
    };
    const response = await qa.navigate(page, 'http://127.0.0.1:9/pacing-test/');
    expect(response.status()).toBe(200);
    expect(calls).toHaveLength(3);
  });
});

describe.skipIf(!hasPython)('pacing.py request profile', () => {
  it('selects the same profiles as the browser helper and parses Retry-After', async () => {
    const { out } = await python(`
import pacing
print(json.dumps({
  'default': pacing.select_profile({}),
  'claude': pacing.select_profile({'CLAUDE_CODE_REMOTE': 'true'})['name'],
  'override': pacing.select_profile({'GITHUB_ACTIONS': 'true', 'TYPEROLL_REQUEST_PROFILE': 'local', 'TYPEROLL_REQUEST_CONCURRENCY': '1'}),
  'seconds': pacing.retry_after('7'),
  'date': pacing.retry_after('Wed, 21 Oct 2026 07:28:00 GMT', now=1792567620),
  'bad': pacing.retry_after('soon'),
  'delays': [pacing.retry_delay(a, 503) for a in range(4)],
  'long': pacing.retry_delay(0, 429, '3600'),
  'not_found': pacing.retry_delay(0, 404),
}))`);
    const value = JSON.parse(out);
    expect(value.default).toMatchObject({ name: 'local', concurrency: 2, interval: 0.3, reason: 'default' });
    expect(value.claude).toBe('cloud');
    expect(value.override).toMatchObject({ name: 'local', concurrency: 1, reason: 'TYPEROLL_REQUEST_PROFILE' });
    expect(value.seconds).toBe(7);
    expect(value.date).toBe(60);
    expect(value.bad).toBeNull();
    expect(value.delays).toEqual([1, 2, 4, null]);
    expect(value.long).toBeNull();
    expect(value.not_found).toBeNull();
  });

  it('spaces request starts per host', async () => {
    const { out } = await python(`
import pacing
clock, slept = [0.0], []
pacer = pacing.Pacer(0.3, clock=lambda: clock[0], sleep=slept.append)
for url in ['https://a.test/1', 'https://a.test/2', 'https://b.test/1', 'https://a.test/3']:
    pacer.wait(url)
print(json.dumps([round(s, 3) for s in slept]))`);
    expect(JSON.parse(out)).toEqual([0.3, 0.6]);
  });

  it('check_url_parity.fetch honours a 429 Retry-After on loopback and announces the profile once', async () => {
    let hits = 0;
    const server = http.createServer((_request, response) => {
      hits += 1;
      if (hits === 1) response.writeHead(429, { 'Retry-After': '0' }).end();
      else response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const { out, err } = await python(`
import check_url_parity
status, location, body = check_url_parity.fetch('http://127.0.0.1:${port}/')
print(json.dumps([status, body.decode()]))`, { TYPEROLL_REQUEST_PROFILE: 'cloud' });
      expect(JSON.parse(out)).toEqual([200, 'ok']);
      expect(hits).toBe(2);
      expect(err.match(/Request profile: cloud/g)).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
