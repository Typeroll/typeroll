// Where the build sandbox comes from, and what happens when a source lies.
//
// Every publication downloads this binary and runs the customer's build inside
// it, so whoever serves it is an availability dependency for publishing. On
// 2026-09-22 snapshot.ubuntu.com returned 5xx for hours and nothing could be
// published. The mirror exists for that; the pinned hash means neither source
// has to be trusted.

import { describe, expect, it } from 'vitest';
import { BWRAP_SOURCES, BWRAP_SHA, BWRAP_URL } from '../../lib/builds/executor.mjs';

describe('sandbox binary sources', () => {
  it('tries canonical upstream first and our mirror only as a fallback', () => {
    // Order matters beyond preference. A mirror tried first is the normal path
    // for every build including self-hosted ones, so a mistake in our bucket
    // would land on everyone's ordinary case. Reached only after upstream has
    // failed, it can only affect the outage it exists for.
    expect(BWRAP_SOURCES.length).toBeGreaterThan(1);
    expect(BWRAP_SOURCES[0]).toContain('snapshot.ubuntu.com');
    expect(BWRAP_SOURCES.slice(1).some((url) => url.includes('r2.dev'))).toBe(true);
    expect(BWRAP_URL).toBe(BWRAP_SOURCES[0]);
  });

  it('pins one hash for every source', () => {
    // The mirror is only safe because it is verified against the same value as
    // upstream. A per-source hash would defeat the point.
    expect(BWRAP_SHA).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(BWRAP_SOURCES).size).toBe(BWRAP_SOURCES.length);
  });

  it('checks bubblewrap once, in source order, instead of requiring every mirror', async () => {
    const { dependencies } = await import('../../../../../scripts/release-dependencies.mjs');
    const bubblewrap = dependencies.filter((d: { sha256: string, urls?: string[] }) => d.sha256 === BWRAP_SHA);
    // CI must not block on a single host outage when a verified fallback exists.
    // One entry tries BWRAP_SOURCES in order, the same rule as acquireSandbox.
    expect(bubblewrap).toHaveLength(1);
    expect(bubblewrap[0].urls).toEqual([...BWRAP_SOURCES]);
    expect(dependencies.some((d: { name: string }) => d.name === 'apparmor-profile')).toBe(true);
  });
});

describe('sandbox /proc on hosts that refuse a nested procfs (Cloudflare, Nov 2026)', async () => {
  const { sandboxProcfs, SANDBOX_PROC, SANDBOX_NO_PROC } = await import('../../lib/builds/executor.mjs');
  const refused = Object.assign(Error('build_process_exit_1'), { output: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" });
  it('keeps a private /proc where the host allows one', async () => {
    expect(await sandboxProcfs(async () => {})).toBe(SANDBOX_PROC);
  });
  it('builds without /proc only when the host refuses exactly that mount', async () => {
    const logs: string[] = [];
    expect(await sandboxProcfs(async (proc: string[]) => { if (proc === SANDBOX_PROC) throw refused; }, (message: string) => logs.push(message))).toBe(SANDBOX_NO_PROC);
    expect(logs).toEqual([expect.stringContaining('building without /proc')]);
    const other = Object.assign(Error('build_process_exit_1'), { output: 'bwrap: setting up uid map: Permission denied' });
    await expect(sandboxProcfs(async () => { throw other; })).rejects.toBe(other);
  });
  it('never exposes the host /proc to build code', () => {
    for (const args of [SANDBOX_PROC, SANDBOX_NO_PROC]) {
      for (let i = 0; i < args.length; i++) if (['--bind', '--ro-bind', '--dev-bind', '--bind-try', '--dev-bind-try'].includes(args[i]!)) expect(args[i + 1]).not.toBe('/proc');
    }
    expect(SANDBOX_NO_PROC.filter((_, i) => SANDBOX_NO_PROC[i - 1] === '--ro-bind-try')).toEqual(['/proc/cpuinfo', '/proc/stat']);
  });
  it('tells an old engine to update instead of reporting a dependency failure', async () => {
    const { buildFailureMessage } = await import('../../lib/builds/failure-message');
    expect(buildFailureMessage('dependencies_build_process_exit_1', { cause: null, lines: ["bwrap: Can't mount proc on /newroot/proc: Operation not permitted"] }))
      .toContain('Update the build engine in Publishing → Builds');
  });
});
