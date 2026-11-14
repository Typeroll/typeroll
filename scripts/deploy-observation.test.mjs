import assert from 'node:assert/strict';
import test from 'node:test';

import { observeDeployJob, providerQueue } from './lib/deploy-observation.mjs';

const MINUTE = 60_000;
const queued = (minutes) => ({
  job: { id: 'job-1', status: 'running', phase: `waiting for Cloudflare to start the build (queued ${minutes} min)` },
  build_progress: { status: 'queued', queue: { state: 'waiting_for_provider', provider: 'cloudflare', message: `queued ${minutes} min`, expires_at: '2026-11-14T14:00:00.000Z' } },
});
const working = (phase = 'building') => ({ job: { id: 'job-1', status: 'running', phase }, build_progress: { status: 'running', queue: null } });
const done = { job: { id: 'job-1', status: 'succeeded', phase: 'live' }, build_progress: null };

function clock() {
  let now = 0;
  return { now: () => now, wait: async (ms) => { now += ms; } };
}

test('a step waiting in the provider queue does not use up the working budget', async () => {
  const time = clock();
  // 40 minutes in the queue, then 5 minutes of work, against a 10-minute budget.
  const final = await observeDeployJob(async () => time.now() < 40 * MINUTE ? queued(Math.floor(time.now() / MINUTE))
    : time.now() < 45 * MINUTE ? working() : done, { ...time, workingBudgetMs: 10 * MINUTE });
  assert.equal(final.job.status, 'succeeded');
});

test('working time beyond the budget stops the observation and names the queue time', async () => {
  const time = clock();
  await assert.rejects(observeDeployJob(async () => time.now() < 5 * MINUTE ? queued(1) : working(), { ...time, workingBudgetMs: 10 * MINUTE }),
    /job job-1 is still running \(building\) after 10 min of working time and 5 min in the build provider's queue\. The job was left running/);
});

test('a queue longer than the limit stops with the provider and the platform expiry', async () => {
  const time = clock();
  await assert.rejects(observeDeployJob(async () => queued(1), { ...time, queueLimitMs: 30 * MINUTE }),
    /still waiting for cloudflare to start a runner .* after 30 min in the queue; the platform fails it at 2026-11-14T14:00:00\.000Z.*nothing was retried/);
});

test('a terminal job is returned as it is, failed included', async () => {
  const failed = { job: { id: 'job-1', status: 'failed', phase: 'failed' } };
  assert.equal(await observeDeployJob(async () => failed), failed);
  assert.equal(providerQueue({ build_progress: { queue: null } }), null);
});
