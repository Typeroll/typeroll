import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

const ORG = 'testorg';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function seedPage(id: string, html: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id,
    slug: id,
    content_mode: 'html',
    status: 'published',
    html_content: html,
  });
}

describe('findPagesMatching', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('finds pages by literal substring with excerpt', async () => {
    await setup();
    await seedPage('home', '<p>The price is 299 kr today.</p>');
    await seedPage('pricing', '<h1>Pricing</h1><p>299 kr per month.</p>');
    await seedPage('about', '<p>About us</p>');

    const { findPagesMatching } = await import('../../lib/bulk-operations');
    const r = await findPagesMatching(ORG, SITE, MAIN_VERSION_ID, { contains: '299 kr' });
    expect(r.total).toBe(2);
    expect(r.matches.map((m) => m.page_id).sort()).toEqual(['home', 'pricing']);
    expect(r.matches[0].excerpt).toContain('299 kr');
  });

  it('supports a regex pattern', async () => {
    await setup();
    await seedPage('a', '<p>foo123</p>');
    await seedPage('b', '<p>bar</p>');
    const { findPagesMatching } = await import('../../lib/bulk-operations');
    const r = await findPagesMatching(ORG, SITE, MAIN_VERSION_ID, { regex: 'foo\\d+' });
    expect(r.matches.map((m) => m.page_id)).toEqual(['a']);
  });

  it('rejects when neither contains nor regex is given', async () => {
    await setup();
    const { findPagesMatching } = await import('../../lib/bulk-operations');
    await expect(findPagesMatching(ORG, SITE, MAIN_VERSION_ID, {})).rejects.toThrow();
  });

  it('caps results at the requested limit', async () => {
    await setup();
    for (let i = 0; i < 5; i++) await seedPage(`p${i}`, '<p>match</p>');
    const { findPagesMatching } = await import('../../lib/bulk-operations');
    const r = await findPagesMatching(ORG, SITE, MAIN_VERSION_ID, { contains: 'match', limit: 3 });
    expect(r.matches.length).toBe(3);
  });
});

describe('bulkReplaceText', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('dry_run reports counts + sample diffs without writing', async () => {
    await setup();
    await seedPage('home', '<p>299 kr today.</p>');
    await seedPage('pricing', '<p>299 kr per month, billed yearly.</p>');

    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    const r = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: '299 kr',
      replacement: '349 kr',
      dryRun: true,
    });
    expect(r.dry_run).toBe(true);
    expect(r.updated).toBe(0);
    expect(r.total_matches).toBe(2);
    expect(r.sample_diffs[0].after).toContain('349 kr');

    // Storage untouched.
    const { vstore } = await import('../../lib/version-store');
    const fresh = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(fresh?.html_content).toContain('299 kr');
  });

  it('real run stages working copies; save=true commits them', async () => {
    await setup();
    await seedPage('home', '<p>299 kr today.</p>');
    await seedPage('about', '<p>About us — 299 kr lifetime.</p>');

    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    // Default: replacements land in each page's working copy only.
    const r = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: '299 kr',
      replacement: '349 kr',
    });
    expect(r.updated).toBe(2);
    expect(r.saved).toBe(0);
    expect(r.total_matches).toBe(2);

    const { vstore } = await import('../../lib/version-store');
    expect((await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home'))?.html_content).toContain('299 kr');
    const { readWorkingCopy } = await import('../../lib/working-copy');
    const wc = await readWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'page', id: 'home' },
    );
    expect(String(wc?.fields.html_content)).toContain('349 kr');

    // save=true commits (the second run matches the drafted content).
    const r2 = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: '349 kr',
      replacement: '399 kr',
      save: true,
    });
    expect(r2.saved).toBe(2);
    const after = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(after?.html_content).toContain('399 kr');
    expect(after?.html_content).not.toContain('299 kr');
  });

  it('honors pageIds to scope the replacement', async () => {
    await setup();
    await seedPage('home', '<p>299 kr</p>');
    await seedPage('about', '<p>299 kr</p>');
    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: '299 kr',
      replacement: '349 kr',
      pageIds: ['home'],
      save: true,
    });
    const { vstore } = await import('../../lib/version-store');
    const home = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    const about = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'about');
    expect(home?.html_content).toContain('349 kr');
    expect(about?.html_content).toContain('299 kr');
  });

  it('escapes regex metachars in literal pattern mode', async () => {
    await setup();
    await seedPage('home', '<p>cost: $9.99 (final)</p>');
    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    const r = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: '$9.99',
      replacement: '$12.99',
      dryRun: true,
    });
    expect(r.total_matches).toBe(1);
    expect(r.sample_diffs[0].after).toContain('$12.99');
  });

  it('rejects when pattern is missing', async () => {
    await setup();
    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    await expect(
      bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, { pattern: '', replacement: 'x' }),
    ).rejects.toThrow();
  });

  it('replaces text in partials, block data, and collection schema fields', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID), {
      name: 'Footer', kind: 'footer', content_mode: 'html', status: 'published',
      html_content: '<a href="/old">Old offer</a>',
    });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/blocks`, {
      title: 'Blocks', slug: 'blocks', status: 'published', content_mode: 'blocks',
      blocks: [{ id: 'b1', type: 'core/text', data: { text: 'Old offer' } }],
    });
    await store.setDoc(paths.collection(ORG, SITE, 'posts', MAIN_VERSION_ID), {
      name: 'posts', label_singular: 'Post', label_plural: 'Posts',
      fields: [{ name: 'body', label: 'Body', type: 'richtext' }],
      created_at: new Date().toISOString(),
    });
    await store.setDoc(paths.collectionItem(ORG, SITE, 'posts', 'one', MAIN_VERSION_ID), {
      status: 'published', body: '<p>Old offer</p>',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    const result = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: 'Old offer', replacement: 'New offer', scope: 'all', save: true,
    });
    expect(result.resource_counts).toEqual({ pages: 1, collection_items: 1, partials: 1 });
    expect(result.saved).toBe(3);

    const { vstore } = await import('../../lib/version-store');
    expect((await vstore.partial(ORG, SITE, MAIN_VERSION_ID, 'footer'))?.html_content).toContain('New offer');
    const page = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'blocks');
    expect(page?.blocks?.[0].data.text).toBe('New offer');
    const item = await vstore.collectionItem(ORG, SITE, MAIN_VERSION_ID, 'posts', 'one');
    expect(item?.body).toContain('New offer');
  });

  it('reports collection-field authority conflicts without staging the item', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.collection(ORG, SITE, 'locked', MAIN_VERSION_ID), {
      name: 'locked', label_singular: 'Entry', label_plural: 'Entries',
      fields: [{ name: 'body', label: 'Body', type: 'text', writable_by: ['portal'] }],
      created_at: new Date().toISOString(),
    });
    await store.setDoc(paths.collectionItem(ORG, SITE, 'locked', 'one', MAIN_VERSION_ID), {
      status: 'published', body: 'Old offer',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const { bulkReplaceText } = await import('../../lib/bulk-operations');
    const result = await bulkReplaceText(ORG, SITE, MAIN_VERSION_ID, {
      pattern: 'Old offer', replacement: 'New offer', scope: 'collection_items', collection: 'locked',
    });
    expect(result.conflicts).toEqual([{ target: { kind: 'item', collection: 'locked', id: 'one' }, fields: ['body'] }]);
    expect(result.updated).toBe(0);
  });
});
