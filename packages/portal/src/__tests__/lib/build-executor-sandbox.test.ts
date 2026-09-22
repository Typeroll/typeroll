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

  it('names every source in the release dependency list', async () => {
    const { dependencies } = await import('../../../../../scripts/release-dependencies.mjs');
    const urls = dependencies.map((d: { url: string }) => d.url);
    for (const source of BWRAP_SOURCES) expect(urls).toContain(source);
    // Every source is checked rather than the first that answers, so a mirror
    // that has drifted is caught before a build finds it.
    expect(dependencies.filter((d: { sha256: string }) => d.sha256 === BWRAP_SHA)).toHaveLength(BWRAP_SOURCES.length);
  });
});
