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

describe('sandbox mounts a build host may refuse (Cloudflare refused /proc in Nov 2026)', async () => {
  const { sandboxMounts, sandboxFeatures, SANDBOX_PROC, SANDBOX_NO_PROC, SANDBOX_MINIMAL_DEV } = await import('../../lib/builds/executor.mjs');
  const features = sandboxFeatures('/tmp/typeroll-build-x/sandbox-tmp');
  const refusal = (line: string) => Object.assign(Error('build_process_exit_1'), { output: `${line}\n` });
  const host = (refuses: Record<string, string>) => async (args: string[]) => {
    for (const [mount, line] of Object.entries(refuses)) if (args.includes(mount)) throw refusal(line);
  };
  it('keeps every private mount where the host allows them', async () => {
    expect(await sandboxMounts(async () => {}, features)).toEqual([...SANDBOX_PROC, '--dev', '/dev', '--tmpfs', '/tmp']);
  });
  it('falls back only for the mounts the host refuses, one at a time', async () => {
    const logs: string[] = [];
    expect(await sandboxMounts(host({ '--proc': "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" }), features, (message: string) => logs.push(message)))
      .toEqual([...SANDBOX_NO_PROC, '--dev', '/dev', '--tmpfs', '/tmp']);
    expect(logs).toEqual([expect.stringContaining('building without /proc')]);
    const all = await sandboxMounts(host({ '--proc': "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
      '--dev': "bwrap: Can't mount devpts on /newroot/dev/pts: Operation not permitted", '--tmpfs': "bwrap: Can't mount tmpfs on /newroot/tmp: Operation not permitted" }), features, () => {});
    expect(all).toEqual([...SANDBOX_NO_PROC, ...SANDBOX_MINIMAL_DEV, '--bind', '/tmp/typeroll-build-x/sandbox-tmp', '/tmp']);
  });
  it('stops on any other refusal, and when a fallback is refused too', async () => {
    const other = refusal('bwrap: setting up uid map: Permission denied');
    await expect(sandboxMounts(async () => { throw other; }, features)).rejects.toBe(other);
    let probes = 0;
    const stubborn = refusal("bwrap: Can't mount proc on /newroot/proc: Operation not permitted");
    await expect(sandboxMounts(async () => { probes++; throw stubborn; }, features, () => {})).rejects.toBe(stubborn);
    expect(probes).toBe(2);
  });
  it('never exposes the host /proc, the whole host /dev or a shared /tmp to build code', () => {
    const binds = ['--bind', '--ro-bind', '--dev-bind', '--bind-try', '--ro-bind-try', '--dev-bind-try'];
    for (const feature of features) for (const args of [feature.preferred, feature.fallback]) {
      for (let i = 0; i < args.length; i++) if (binds.includes(args[i]!)) expect(['/proc', '/dev', '/tmp']).not.toContain(args[i + 1]);
    }
    expect(SANDBOX_NO_PROC.filter((_, i) => SANDBOX_NO_PROC[i - 1] === '--ro-bind-try')).toEqual(['/proc/cpuinfo', '/proc/stat']);
    expect(SANDBOX_MINIMAL_DEV.filter((_, i) => SANDBOX_MINIMAL_DEV[i - 1] === '--dev-bind')).toEqual(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']);
  });
  it('tells an old engine to update instead of reporting a dependency failure', async () => {
    const { buildFailureMessage } = await import('../../lib/builds/failure-message');
    expect(buildFailureMessage('dependencies_build_process_exit_1', { cause: null, lines: ["bwrap: Can't mount proc on /newroot/proc: Operation not permitted"] }))
      .toContain('Update the build engine in Publishing → Builds');
  });
});
