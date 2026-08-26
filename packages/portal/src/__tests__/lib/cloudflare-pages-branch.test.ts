// CF Pages adapter branch handling — verify that branchName is slugified
// and used as the --branch flag, and that the fallback URL is branch-
// aware.

import { describe, it, expect, vi } from 'vitest';
import type { DeployOptions } from '../../lib/hosting';

// Spawn mock: replace child_process.spawn so we don't actually shell out
// to wrangler. The adapter parses spawn args to build the --branch flag,
// which is what we want to assert on.
interface SpawnArgs {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
}

function setupSpawnMock(args: SpawnArgs[]): void {
  vi.doMock('node:child_process', () => ({
    spawn: (command: string, cmdArgs: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => {
      args.push({ command, args: cmdArgs, cwd: opts.cwd, env: opts.env ?? {} });
      // Return a mock child process. We resolve quickly with success +
      // the success-line wrangler would print.
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const stream = {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event].push(cb);
        },
      };
      setTimeout(() => {
        (handlers.exit ?? []).forEach((cb) => cb(0));
      }, 5);
      return {
        stdout: stream,
        stderr: stream,
        on: (event: string, cb: (...a: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event].push(cb);
        },
      } as unknown;
    },
  }));
  // Stub existsSync so findWranglerBin() resolves without the real 30MB
  // binary — a unit test shouldn't need wrangler installed to assert on
  // the --branch flag.
  //
  // Both the named export AND `default` have to be patched. The adapter
  // does `import fs from 'node:fs'`, so it reads `default.existsSync`;
  // spreading the actual namespace carries the real `default` object
  // through untouched, and overriding the named export alone leaves the
  // adapter calling the real one. That was the bug here: these tests
  // passed only where wrangler happened to be installed (CI, and any
  // checkout with a full npm install) and failed everywhere else —
  // mocked in name only.
  //
  // The stub answers only for the wrangler lookup and defers to the real
  // existsSync otherwise. An unconditional `() => true` also neutered the
  // adapter's own `if (!fs.existsSync(buildDir)) throw` guard, so these tests
  // could never have caught that check being dropped — a mock that makes the
  // code under test unfalsifiable is only half a mock.
  vi.doMock('node:fs', async () => {
    const real = (await vi.importActual('node:fs')) as Record<string, unknown> & {
      default: Record<string, unknown>;
    };
    const realExists = real.existsSync as (p: unknown) => boolean;
    const existsSync = (p: unknown) =>
      typeof p === 'string' && p.includes('wrangler') ? true : realExists(p);
    return { ...real, existsSync, default: { ...real.default, existsSync } };
  });
}

describe('CloudflarePagesAdapter branch handling', () => {
  it('uses opts.branchName (slugified) when set', async () => {
    const calls: SpawnArgs[] = [];
    vi.resetModules();
    setupSpawnMock(calls);

    const { CloudflarePagesAdapter } = await import('../../lib/hosting/cloudflare-pages');
    const adapter = new CloudflarePagesAdapter({
      accountId: 'a', apiToken: 't', projectName: 'demo',
    });
    await adapter.deploy('/tmp', {
      environment: 'production',
      siteId: 'demo',
      branchName: 'Pricing Refresh',
    } satisfies DeployOptions);
    const branchFlag = calls[0].args.find((a) => a.startsWith('--branch='));
    expect(branchFlag).toBe('--branch=pricing-refresh');
  });

  it('falls back to environment when branchName is not set', async () => {
    const calls: SpawnArgs[] = [];
    vi.resetModules();
    setupSpawnMock(calls);

    const { CloudflarePagesAdapter } = await import('../../lib/hosting/cloudflare-pages');
    const adapter = new CloudflarePagesAdapter({
      accountId: 'a', apiToken: 't', projectName: 'demo',
    });
    await adapter.deploy('/tmp', { environment: 'staging', siteId: 'demo' });
    const branchFlag = calls[0].args.find((a) => a.startsWith('--branch='));
    expect(branchFlag).toBe('--branch=staging');
  });

  it('production with no branchName uses --branch=main', async () => {
    const calls: SpawnArgs[] = [];
    vi.resetModules();
    setupSpawnMock(calls);

    const { CloudflarePagesAdapter } = await import('../../lib/hosting/cloudflare-pages');
    const adapter = new CloudflarePagesAdapter({
      accountId: 'a', apiToken: 't', projectName: 'demo',
    });
    const result = await adapter.deploy('/tmp', { environment: 'production', siteId: 'demo' });
    const branchFlag = calls[0].args.find((a) => a.startsWith('--branch='));
    expect(branchFlag).toBe('--branch=main');
    // Fallback URL for main is the bare project URL (CF Pages convention).
    expect(result.url).toBe('https://demo.pages.dev');
  });

  it('non-main branch fallback URL is prefixed with the branch', async () => {
    const calls: SpawnArgs[] = [];
    vi.resetModules();
    setupSpawnMock(calls);

    const { CloudflarePagesAdapter } = await import('../../lib/hosting/cloudflare-pages');
    const adapter = new CloudflarePagesAdapter({
      accountId: 'a', apiToken: 't', projectName: 'demo',
    });
    const result = await adapter.deploy('/tmp', {
      environment: 'production',
      siteId: 'demo',
      branchName: 'feature',
    });
    expect(result.url).toBe('https://feature.demo.pages.dev');
  });
});
