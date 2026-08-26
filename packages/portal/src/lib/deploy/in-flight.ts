// "Is a build already running for this site?"
//
// Nothing asked this before, so nothing stopped a second concurrent build of
// the same site: the deploy route created a job and enqueued unconditionally,
// and the publish sweep only consulted the debounce marker. Two admins
// pressing Deploy, one double-click, or the sweep firing mid-build all
// produced two builds of the same content.
//
// It never corrupted anything — each build materializes into its own temp
// directory — but both uploaded to the same Cloudflare Pages project, so the
// LAST one to finish wins and that is not necessarily the newest snapshot. Two
// builds started a minute apart can land in the wrong order.
//
// One definition, used by every trigger, because a guard that only some
// callers consult is the same bug with more steps.

import type { DeployJob } from '@typeroll/shared';

/**
 * How long a job may sit in a non-terminal state before we stop believing it.
 *
 * A crashed worker (OOM, an instance torn down mid-build) leaves `running`
 * behind forever, and a permanently-blocked Deploy button is worse than an
 * occasional double build. The window has to outlast a legitimate slow build:
 * `astro build` alone gets 10 minutes and Cloud Run's request limit is 15, so
 * 20 covers the whole deploy with room to spare.
 */
export const DEPLOY_STALE_AFTER_MS = 20 * 60 * 1000;

const ACTIVE_STATUSES: ReadonlySet<DeployJob['status']> = new Set(['queued', 'running']);

/**
 * The job currently occupying this site, or null.
 *
 * Newest first among candidates, so a caller that reports the id back to the
 * client points at the build actually in progress rather than an older stuck
 * one that happens to sort first.
 */
export function findActiveDeploy(
  jobs: DeployJob[],
  now: number = Date.now(),
): DeployJob | null {
  const active = jobs
    .filter((j) => ACTIVE_STATUSES.has(j.status) && !isStale(j, now))
    .sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
  return active[0] ?? null;
}

/**
 * Unparseable or absent `started_at` counts as stale rather than active. A job
 * we cannot date is a job we cannot age out, and treating it as live would
 * block the site's Deploy button permanently.
 */
function isStale(job: DeployJob, now: number): boolean {
  const started = Date.parse(job.started_at ?? '');
  if (Number.isNaN(started)) return true;
  return now - started >= DEPLOY_STALE_AFTER_MS;
}
