import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { readSnapshot, saveSnapshot } from '../../lib/publishing/publication-snapshot';
import { publicationRetentionPlan, pruneSitePublicationSnapshots, type RetentionJob } from '../../lib/publishing/publication-retention';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
afterEach(() => vi.restoreAllMocks());

const now = Date.parse('2026-11-06T00:00:00Z');
const job = (id: string, extra: Partial<RetentionJob> = {}): RetentionJob => ({ id, status: 'succeeded', version_id: 'main', environment: 'production',
  finished_at: '2026-01-01T00:00:00Z', git_publication: { snapshot_digest: id, snapshot_chunks: 1, snapshot_format: 1 }, ...extra });

it('keeps the latest three per version, active jobs, site references and the transitive dependency graph', () => {
  const jobs = ['1', '2', '3', '4', '5', '6', '7', '8'].map(id => job(id, { finished_at: `2026-01-0${id}T00:00:00Z` }));
  jobs[4]!.source_publication = { snapshot_job_id: '2' };
  jobs.push(job('active', { status: 'running', finished_at: null, source_publication: { base_job_id: '1' } }));
  jobs.push(job('branch', { version_id: 'next' }));
  const { candidates, retained } = publicationRetentionPlan({ jobs, references: [{ last_publication: { snapshot_job_id: '5' } }, { candidate: { job_id: '3' } }], now });
  expect(candidates.map(candidate => candidate.job_id)).toEqual(['4']);
  expect(retained.find(entry => entry.job_id === '2')!.reasons).toEqual(['retained_publication_dependency']);
  expect(retained.find(entry => entry.job_id === '1')!.reasons).toEqual(['retained_publication_dependency']);
  expect(retained.find(entry => entry.job_id === 'branch')!.reasons).toEqual(['latest_three']);
});

it('keeps failed publications for seven days and succeeded ones for thirty', () => {
  const day = 86_400_000;
  const jobs = [
    job('failed-8d', { status: 'failed', finished_at: new Date(now - 8 * day).toISOString() }),
    job('failed-6d', { status: 'failed', finished_at: new Date(now - 6 * day).toISOString() }),
    job('unknown', { status: 'failed', finished_at: null }),
    ...['a', 'b', 'c'].map(id => job(id, { finished_at: new Date(now - 60 * day).toISOString() })),
    job('ok-31d', { finished_at: new Date(now - 61 * day).toISOString() }),
    job('ok-29d', { version_id: 'next', finished_at: new Date(now - 29 * day).toISOString() }),
  ];
  expect(publicationRetentionPlan({ jobs, now }).candidates.map(candidate => candidate.job_id)).toEqual(['failed-8d', 'ok-31d']);
});

it('ignores references to missing publications, already pruned snapshots and records without a snapshot', () => {
  const jobs = [job('x', { status: 'failed' }), job('pruned', { status: 'failed', git_publication: { snapshot_digest: 'p', snapshot_chunks: 1, snapshot_pruned_at: '2026-02-01T00:00:00Z' } }),
    job('compact', { status: 'failed', git_publication: null })];
  expect(publicationRetentionPlan({ jobs, references: [{ snapshot_job_id: 'gone' }], now }).candidates.map(candidate => candidate.job_id)).toEqual(['x']);
  expect(() => publicationRetentionPlan({ jobs: [job('d'), job('d')], now })).toThrow(/inventory/);
});

it('deletes only expired snapshot chunks, keeps the deploy record and marks it', async () => {
  const store = getStore(), org = 'org-1', site = 'site-1';
  await store.setDoc(paths.site(org, site), { name: 'Site', publishing_mode: 'customer_git' });
  const old = new Date(now - 90 * 86_400_000).toISOString();
  const saved: Record<string, any> = {};
  for (const id of ['old', 'live', 'r1', 'r2', 'r3']) {
    saved[id] = await saveSnapshot({ orgId: org, siteId: site, jobId: id }, { pages: [id], body: 'x'.repeat(130_000) });
    await store.setDoc(paths.deploy(org, site, id), { status: 'succeeded', version_id: 'main', environment: 'production',
      finished_at: id === 'old' || id === 'live' ? old : new Date(now - 40 * 86_400_000 + Number(id[1] ?? 0)).toISOString(), git_publication: { ...saved[id], publication_id: id } });
  }
  await store.setDoc(`${paths.site(org, site)}/publishing_targets/main`, { job_id: null, last_publication: { snapshot_job_id: 'live' } });
  expect(saved.old.snapshot_chunks).toBe(2);

  expect(await pruneSitePublicationSnapshots(org, site, { now })).toEqual({ pruned: 1, remaining: 0 });
  await expect(readSnapshot({ orgId: org, siteId: site, jobId: 'old' }, saved.old)).rejects.toMatchObject({ code: 'publication_snapshot_incomplete' });
  for (const id of ['live', 'r1', 'r2', 'r3']) expect((await readSnapshot({ orgId: org, siteId: site, jobId: id }, saved[id])).pages).toEqual([id]);
  const record = await store.getDoc<any>(paths.deploy(org, site, 'old'));
  expect(record.status).toBe('succeeded');
  expect(record.git_publication.publication_id).toBe('old');
  expect(record.git_publication.snapshot_pruned_at).toBe(new Date(now).toISOString());
  expect(await pruneSitePublicationSnapshots(org, site, { now })).toEqual({ pruned: 0, remaining: 0 });
});

it('drains a backlog in bounded runs and leaves hosted sites alone', async () => {
  const store = getStore(), org = 'org-1';
  for (const [site, mode] of [['customer', 'customer_git'], ['hosted', 'hosted']] as const) {
    await store.setDoc(paths.site(org, site), { name: site, publishing_mode: mode });
    for (let index = 0; index < 6; index++) {
      const id = `job-${index}`;
      const reference = await saveSnapshot({ orgId: org, siteId: site, jobId: id }, { index });
      await store.setDoc(paths.deploy(org, site, id), { status: 'failed', version_id: 'main', finished_at: '2026-01-01T00:00:00Z', git_publication: reference });
    }
  }
  expect(await pruneSitePublicationSnapshots(org, 'customer', { now, limit: 4 })).toEqual({ pruned: 4, remaining: 2 });
  expect(await pruneSitePublicationSnapshots(org, 'customer', { now, limit: 4 })).toEqual({ pruned: 2, remaining: 0 });
  expect(await pruneSitePublicationSnapshots(org, 'hosted', { now })).toEqual({ pruned: 0, remaining: 0 });
  expect((await store.getDoc<any>(paths.deploy(org, 'hosted', 'job-0'))).git_publication.snapshot_pruned_at).toBeUndefined();
});

it('never throws into the publication', async () => {
  vi.spyOn(getStore(), 'listDocs').mockRejectedValue(new Error('store unavailable'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await getStore().setDoc(paths.site('o', 's'), { publishing_mode: 'customer_git' });
  expect(await pruneSitePublicationSnapshots('o', 's', { now })).toEqual({ pruned: 0, remaining: null });
  expect(error).toHaveBeenCalledWith(expect.stringContaining('publication_snapshot_prune_failed'));
});
