// Scheduled publishing sweep: due publish_at/unpublish_at flip status on
// pages + collection items (main version), the schedule field clears so a
// re-run is a no-op (Cloud Scheduler is at-least-once), and each affected
// site gets exactly ONE deploy no matter how many docs flipped.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const enqueued: unknown[] = [];
vi.mock('../../lib/deploy/queue', () => ({
  getDeployQueue: () => ({ enqueue: async (args: unknown) => { enqueued.push(args); } }),
}));

const NOW = new Date('2026-07-08T12:00:00Z');
const PAST = '2026-07-08T11:00:00Z';
const FUTURE = '2026-07-08T13:00:00Z';

async function seed(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.org(ORG), { name: 'Org', created_at: PAST });
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: PAST });
  const pages = paths.pages(ORG, SITE, MAIN_VERSION_ID);
  await store.setDoc(`${pages}/due`, {
    title: 'Due', slug: 'due', status: 'draft', content_mode: 'blocks', blocks: [],
    publish_at: PAST,
  });
  await store.setDoc(`${pages}/later`, {
    title: 'Later', slug: 'later', status: 'draft', content_mode: 'blocks', blocks: [],
    publish_at: FUTURE,
  });
  await store.setDoc(`${pages}/expiring`, {
    title: 'Expiring', slug: 'expiring', status: 'published', content_mode: 'blocks', blocks: [],
    date_published: '2026-01-01T00:00:00Z', unpublish_at: PAST,
  });
  await store.setDoc(paths.collections(ORG, SITE, MAIN_VERSION_ID) + '/blog', {
    name: 'blog', label: 'Blog', fields: [{ name: 'title', type: 'text', label: 'Title' }],
    created_at: PAST,
  });
  await store.setDoc(paths.collectionItems(ORG, SITE, 'blog', MAIN_VERSION_ID) + '/post1', {
    title: 'Post', status: 'draft', created_at: PAST, updated_at: PAST, publish_at: PAST,
  });
}

describe('runPublishSweep', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    enqueued.length = 0;
    await seed();
  });

  it('flips due docs, stamps date_published, clears timers, deploys once per site', async () => {
    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep(NOW);

    expect(result.pages_published).toBe(1);
    expect(result.pages_unpublished).toBe(1);
    expect(result.items_published).toBe(1);
    expect(result.errors).toEqual([]);

    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    const pages = paths.pages(ORG, SITE, MAIN_VERSION_ID);

    const due = await store.getDoc<Page>(`${pages}/due`);
    expect(due?.status).toBe('published');
    expect(due?.date_published).toBe(NOW.toISOString());
    expect(typeof due?.publish_at === 'string' && due.publish_at !== '').toBe(false);

    const later = await store.getDoc<Page>(`${pages}/later`);
    expect(later?.status).toBe('draft');
    expect(later?.publish_at).toBe(FUTURE);

    const expiring = await store.getDoc<Page>(`${pages}/expiring`);
    expect(expiring?.status).toBe('draft');
    // Original publish stamp survives an unpublish.
    expect(expiring?.date_published).toBe('2026-01-01T00:00:00Z');

    const item = await store.getDoc<{ status: string }>(
      `${paths.collectionItems(ORG, SITE, 'blog', MAIN_VERSION_ID)}/post1`,
    );
    expect(item?.status).toBe('published');

    // Three flips on one site → exactly one deploy, marked as scheduled.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ orgId: ORG, siteId: SITE, environment: 'production' });
    const jobs = await store.listDocs<{ triggered_by?: string; status?: string }>(paths.deploys(ORG, SITE));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].triggered_by).toBe('scheduled-publish');
    expect(jobs[0].status).toBe('queued');
  });

  it('re-running the sweep is a no-op (idempotent under at-least-once triggers)', async () => {
    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    await runPublishSweep(NOW);
    enqueued.length = 0;

    const second = await runPublishSweep(NOW);
    expect(second.pages_published).toBe(0);
    expect(second.pages_unpublished).toBe(0);
    expect(second.items_published).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('an already-published page with a stale publish_at does not refire or redeploy', async () => {
    const { getStore } = await import('../../lib/datastore');
    const pages = paths.pages(ORG, SITE, MAIN_VERSION_ID);
    // User manually published before the timer fired.
    await getStore().updateDoc(`${pages}/due`, { status: 'published', date_published: '2026-06-01T00:00:00Z' });
    // Remove the other due docs so nothing else triggers a deploy.
    await getStore().updateDoc(`${pages}/expiring`, { unpublish_at: null });
    await getStore().updateDoc(
      `${paths.collectionItems(ORG, SITE, 'blog', MAIN_VERSION_ID)}/post1`,
      { publish_at: null },
    );

    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep(NOW);
    expect(result.pages_published).toBe(0);
    expect(enqueued).toHaveLength(0);
    const due = await getStore().getDoc<Page>(`${pages}/due`);
    expect(due?.date_published).toBe('2026-06-01T00:00:00Z');
  });
});
