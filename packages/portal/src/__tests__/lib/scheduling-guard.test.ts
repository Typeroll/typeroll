import { beforeEach, expect, it } from 'vitest';
import { getStore } from '../../lib/datastore';
import { MAX_POLLS_WITHOUT_PROGRESS, POLL_DELAYS_MS, schedulePublication, waitForPublicationCondition } from '../../lib/scheduling/continuation';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const job = 'organizations/o/sites/s/deploys/j';
const delay = async () => { const saved = await getStore().getDoc<any>(job); return saved.continuation.due_at - Date.now(); };
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); await getStore().setDoc(job, { status: 'running' }); });

it('keeps backing off when the phase name alternates without progress', async () => {
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) { await waitForPublicationCondition(job, i % 2 ? 'distributing' : 'waiting for Cloudflare Pages'); seen.push(await delay()); }
  expect(seen.slice(-2).every(value => value > POLL_DELAYS_MS.at(-1)! - 1000)).toBe(true);
});

it('restarts quick polling only after progress', async () => {
  for (let i = 0; i < 6; i++) await waitForPublicationCondition(job, 'distributing');
  await schedulePublication(job, 'build dispatched');
  await waitForPublicationCondition(job, 'distributing');
  expect(await delay()).toBeLessThanOrEqual(POLL_DELAYS_MS[1]!);
});

it('fails a publication that polls without progress beyond its budget', async () => {
  const saved = await getStore().getDoc<any>(job);
  await getStore().setDoc(job, { ...saved, continuation: { token: 't', reason: 'distributing', due_at: 0, attempt: 0, polls: MAX_POLLS_WITHOUT_PROGRESS } });
  await expect(waitForPublicationCondition(job, 'distributing')).rejects.toMatchObject({ code: 'continuation_budget_exceeded' });
});
