// Which verified source fingerprint a publication impact compares with.
import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const snapshots = vi.hoisted(() => new Map<string, any>());
vi.mock('../../lib/publishing/publication-snapshot', () => ({ readSnapshot: vi.fn(async ({ jobId }: { jobId: string }) => {
  if (!snapshots.has(jobId)) throw new Error('snapshot missing'); return snapshots.get(jobId);
}) }));
import { verifiedBaseline } from '../../lib/publishing/impact-preview';

const fingerprint = { protocol: 2, org_id: 'org', site_id: 'site', version_id: 'main', core_commit: 'a', entries: [] };
const reference = (job: string) => ({ publication_id: `publication-${job}`, snapshot_job_id: job, snapshot_digest: 'd'.repeat(64), snapshot_chunks: 1 });
const job = (id: string, value: Record<string, unknown>) => getStore().setDoc(paths.deploy('org', 'site', id), { version_id: 'main', ...value });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); snapshots.clear(); });

it('compares with the last normal publication', async () => {
  await job('normal', { status: 'succeeded' }); snapshots.set('normal', { version_id: 'main', source_impact_snapshot: fingerprint });
  expect(await verifiedBaseline('org', 'site', 'main', reference('normal'))).toMatchObject({ snapshot: fingerprint, publication_id: 'publication-normal', via_domain_change: false });
});

// A domain switch prepared before this release recorded no fingerprint; it republished its source publication's content.
it('follows a domain change without a fingerprint to the publication it republished', async () => {
  await job('normal', { status: 'succeeded' }); snapshots.set('normal', { version_id: 'main', source_impact_snapshot: fingerprint });
  await job('domain', { status: 'succeeded', publication_intent: 'domain_prepare', source_publication: reference('normal') }); snapshots.set('domain', { version_id: 'main' });
  expect(await verifiedBaseline('org', 'site', 'main', reference('domain'))).toMatchObject({ snapshot: fingerprint, publication_id: 'publication-normal', via_domain_change: true });
  // While it waits for DNS approval its job is still running, but it already serves main.
  await getStore().updateDoc(paths.deploy('org', 'site', 'domain'), { status: 'running', phase: 'awaiting domain cutover approval' });
  expect(await verifiedBaseline('org', 'site', 'main', reference('domain'))).toMatchObject({ publication_id: 'publication-normal' });
});

it('names why there is no baseline', async () => {
  expect(await verifiedBaseline('org', 'site', 'main', undefined)).toEqual({ snapshot: null, reason: 'not_published' });
  await job('dry', { status: 'succeeded', dry_run: true });
  expect(await verifiedBaseline('org', 'site', 'main', reference('dry'))).toEqual({ snapshot: null, reason: 'publication_not_verified' });
  await job('old', { status: 'succeeded' }); snapshots.set('old', { version_id: 'main' });
  expect(await verifiedBaseline('org', 'site', 'main', reference('old'))).toEqual({ snapshot: null, reason: 'snapshot_without_source_baseline' });
  await job('domain', { status: 'succeeded', publication_intent: 'domain_prepare', source_publication: reference('pruned') }); snapshots.set('domain', { version_id: 'main' });
  await job('pruned', { status: 'succeeded' });
  expect(await verifiedBaseline('org', 'site', 'main', reference('domain'))).toEqual({ snapshot: null, reason: 'baseline_snapshot_unreadable' });
  // The last publication's own snapshot failing to read stays an error, as before.
  await job('broken', { status: 'succeeded' });
  await expect(verifiedBaseline('org', 'site', 'main', reference('broken'))).rejects.toThrow('snapshot missing');
});

it('stops after a bounded chain of domain changes', async () => {
  for (let i = 0; i < 8; i++) { await job(`d${i}`, { status: 'succeeded', publication_intent: 'domain_prepare', source_publication: reference(`d${i + 1}`) }); snapshots.set(`d${i}`, { version_id: 'main' }); }
  expect(await verifiedBaseline('org', 'site', 'main', reference('d0'))).toEqual({ snapshot: null, reason: 'snapshot_without_source_baseline' });
});
