import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { observePublicationServing } from '../../lib/publishing/publication-serving';
import { canRetryVerification } from '../../components/verificationStatus';
const probe = vi.hoisted(() => vi.fn());
vi.mock('../../lib/deploy/availability', () => ({ probePublication: probe }));
const path = 'organizations/org/sites/site/deploys/job';
const publication = { website_host: 'example.com', publication_id: 'a'.repeat(64) };
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); await getStore().setDoc(path, { status: 'running' }); probe.mockReset(); });
it.each([
  [true, false, 'a'.repeat(64), 'live_unverified'],
  [true, true, 'a'.repeat(64), 'verified'],
  [false, true, 'b'.repeat(64), 'different_publication'],
  [false, false, null, 'unavailable'],
])('records identity independently from job/check status (%s, %s)', async (ready, verified, observed, state) => {
  probe.mockImplementation(async (_origin, _route, _expected, { observe }) => {
    await observe({ host: 'example.com', ready, observed_publication: observed, checked_at: '2026-11-18T08:00:00Z' }); return ready;
  });
  expect(await observePublicationServing(path, publication, verified as boolean)).toMatchObject({ state, observed_publication: observed, publication_id: publication.publication_id });
  expect(await getStore().getDoc(path)).toMatchObject({ status: 'running', serving: { state } });
});
it('offers verification retry only for an observed live verification failure, not a failed build', () => {
  const job = { status: 'failed' as const, failure: { code: 'shared_runner_start_failed' } };
  expect(canRetryVerification(job)).toBe(false);
  expect(canRetryVerification({ ...job, serving: { state: 'live_unverified', publication_id: publication.publication_id, observed_publication: publication.publication_id, url: 'https://example.com', checked_at: 'now' } })).toBe(true);
});
