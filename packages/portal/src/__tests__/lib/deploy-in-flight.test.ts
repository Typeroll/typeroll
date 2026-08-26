// One build per site at a time.
//
// Nothing enforced this: the deploy route created a job and enqueued
// unconditionally, and the sweep consulted only the debounce marker. Two
// concurrent builds of the same site both upload to the same Cloudflare Pages
// project, so the last to FINISH wins — and that is not necessarily the newest
// snapshot.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DeployJob } from '@typeroll/shared';
import {
  DEPLOY_STALE_AFTER_MS,
  findActiveDeploy,
} from '../../lib/deploy/in-flight';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');

function job(over: Partial<DeployJob> & { id: string }): DeployJob {
  return {
    version_id: 'main',
    environment: 'production',
    status: 'running',
    started_at: new Date(NOW - 60_000).toISOString(),
    ...over,
  } as DeployJob;
}

describe('findActiveDeploy', () => {
  it('finds a running build', () => {
    expect(findActiveDeploy([job({ id: 'a' })], NOW)?.id).toBe('a');
  });

  it('finds a queued build — enqueue-to-pickup is exactly when a double-click lands', () => {
    expect(findActiveDeploy([job({ id: 'a', status: 'queued' })], NOW)?.id).toBe('a');
  });

  it('ignores terminal builds', () => {
    const jobs = [
      job({ id: 'a', status: 'succeeded' }),
      job({ id: 'b', status: 'failed' }),
    ];
    expect(findActiveDeploy(jobs, NOW)).toBeNull();
  });

  it('ages out a job whose worker died mid-build', () => {
    // A torn-down instance leaves `running` behind forever. A permanently
    // blocked Deploy button is worse than an occasional double build.
    const dead = job({ id: 'a', started_at: new Date(NOW - DEPLOY_STALE_AFTER_MS - 1).toISOString() });
    expect(findActiveDeploy([dead], NOW)).toBeNull();
  });

  it('still holds a slow build just inside the window', () => {
    const slow = job({ id: 'a', started_at: new Date(NOW - DEPLOY_STALE_AFTER_MS + 1000).toISOString() });
    expect(findActiveDeploy([slow], NOW)?.id).toBe('a');
  });

  it('outlasts the astro build timeout', () => {
    // astro alone gets 10 minutes and the Cloud Run request limit is 15, so a
    // window shorter than that would age out builds that are still working.
    expect(DEPLOY_STALE_AFTER_MS).toBeGreaterThan(15 * 60 * 1000);
  });

  it('treats an undateable job as stale rather than blocking the site forever', () => {
    expect(findActiveDeploy([job({ id: 'a', started_at: 'not-a-date' })], NOW)).toBeNull();
    expect(findActiveDeploy([job({ id: 'a', started_at: undefined as unknown as string })], NOW)).toBeNull();
  });

  it('returns the newest active job, not an older stuck one', () => {
    const jobs = [
      job({ id: 'old', started_at: new Date(NOW - 600_000).toISOString() }),
      job({ id: 'new', started_at: new Date(NOW - 5_000).toISOString() }),
    ];
    // The caller reports this id back to the client, which then polls it — so
    // it has to be the build actually in progress.
    expect(findActiveDeploy(jobs, NOW)?.id).toBe('new');
  });

  it('returns null for a site that has never deployed', () => {
    expect(findActiveDeploy([], NOW)).toBeNull();
  });
});
