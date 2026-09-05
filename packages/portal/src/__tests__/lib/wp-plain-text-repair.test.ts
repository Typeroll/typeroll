import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { CollectionDef, Page, Site, SiteVersion } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'repair-org';
const SITE = 'repair-site';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Repair Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function seedPage(id: string, overrides: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id,
    slug: id,
    content_mode: 'html',
    status: 'published',
    html_content: '<h1>Body &amp; markup must stay unchanged</h1>',
    ...overrides,
  });
}

async function seedCollection(definition: CollectionDef): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.collection(ORG, SITE, definition.name, MAIN_VERSION_ID), definition);
}

describe('repairWordPressPlainText', () => {
  beforeEach(setup);

  it('defaults to a reviewable dry run and never touches rich content or URLs', async () => {
    await seedPage('home', {
      title: '<strong>Flytt &amp; städning</strong>',
      seo_title: 'Flytt &#8211; enkelt',
      seo_description: 'Tryggt &amp;amp; tydligt',
      canonical_url: 'https://example.com/?label=Flytt&amp;städning',
    });

    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    const result = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {});

    expect(result).toMatchObject({
      dry_run: true,
      updated: 0,
      saved: 0,
      resources_with_changes: 1,
      fields_with_changes: 3,
      conflicts: [],
    });
    expect(result.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', before: '<strong>Flytt &amp; städning</strong>', after: 'Flytt & städning' }),
      expect.objectContaining({ field: 'seo_title', before: 'Flytt &#8211; enkelt', after: 'Flytt – enkelt' }),
      expect.objectContaining({ field: 'seo_description', before: 'Tryggt &amp;amp; tydligt', after: 'Tryggt &amp; tydligt' }),
    ]));

    const { vstore } = await import('../../lib/version-store');
    const page = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(page?.title).toBe('<strong>Flytt &amp; städning</strong>');
    expect(page?.html_content).toContain('&amp;');
    expect(page?.canonical_url).toContain('&amp;');
  });

  it('repairs only allowlisted plain-text collection fields and respects field authority', async () => {
    await seedCollection({
      id: 'services',
      name: 'services',
      label_singular: 'Service',
      label_plural: 'Services',
      slug_field: 'slug',
      fields: [
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
        { name: 'seo_description', label: 'SEO description', type: 'textarea', writable_by: ['portal'] },
        { name: 'body', label: 'Body', type: 'richtext' },
      ],
      created_at: new Date().toISOString(),
    });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'services', 'packing', MAIN_VERSION_ID), {
      status: 'published',
      slug: 'packing-&amp;-moving',
      title: '<em>Packing &amp; moving</em>',
      excerpt: 'Fast &#038; careful',
      seo_description: 'Locked &amp; field',
      body: '<p>Rich &amp; content</p>',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    const result = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      scope: 'collection_items',
      collection: 'services',
    });

    expect(result.resources_with_changes).toBe(0);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        target: { kind: 'item', collection: 'services', id: 'packing' },
        reason: 'field_authority',
        fields: ['seo_description'],
      }),
    ]);
    expect(result.diffs).toEqual([]);
  });

  it('repairs collection titles and excerpts without changing slug or rich HTML', async () => {
    await seedCollection({
      id: 'articles',
      name: 'articles',
      label_singular: 'Article',
      label_plural: 'Articles',
      slug_field: 'slug',
      fields: [
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
        { name: 'body', label: 'Body', type: 'richtext' },
      ],
      created_at: new Date().toISOString(),
    });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'articles', 'moving', MAIN_VERSION_ID), {
      status: 'published',
      slug: 'flytta-&amp;-stadning',
      title: '<strong>Flytta</strong> &amp; städa',
      excerpt: 'Caf&eacute; &#8211; råd',
      body: '<p>Keep <strong>rich &amp; HTML</strong></p>',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    const result = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      scope: 'collection_items',
      collection: 'articles',
      dryRun: false,
      save: true,
    });
    expect(result).toMatchObject({ updated: 1, saved: 1, fields_with_changes: 2 });
    const { vstore } = await import('../../lib/version-store');
    const item = await vstore.collectionItem(ORG, SITE, MAIN_VERSION_ID, 'articles', 'moving');
    expect(item?.title).toBe('Flytta & städa');
    expect(item?.excerpt).toBe('Café – råd');
    expect(item?.slug).toBe('flytta-&amp;-stadning');
    expect(item?.body).toBe('<p>Keep <strong>rich &amp; HTML</strong></p>');
  });

  it('creates a working copy or commits through the normal save path', async () => {
    await seedPage('drafted', { title: 'Drafted &amp; title' });
    await seedPage('saved', { title: '<b>Saved</b> &amp; title' });
    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    const draftResult = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      pageIds: ['drafted'],
      dryRun: false,
    });
    const saveResult = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      pageIds: ['saved'],
      dryRun: false,
      save: true,
    });

    expect(draftResult).toMatchObject({ updated: 1, saved: 0 });
    expect(saveResult).toMatchObject({ updated: 1, saved: 1 });
    const { vstore } = await import('../../lib/version-store');
    const { readWorkingCopy } = await import('../../lib/working-copy');
    expect((await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'drafted'))?.title).toBe('Drafted &amp; title');
    expect((await readWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'page', id: 'drafted' },
    ))?.fields.title).toBe('Drafted & title');
    expect((await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'saved'))?.title).toBe('Saved & title');
  });

  it('skips a resource with an existing working copy instead of overwriting or committing it', async () => {
    await seedPage('home', { title: 'Old &amp; title' });
    const { mergeWorkingCopy, readWorkingCopy } = await import('../../lib/working-copy');
    const context = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };
    await mergeWorkingCopy(context, { kind: 'page', id: 'home' }, { seo_title: 'Human draft' }, 'editor');

    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    const result = await repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      dryRun: false,
      save: true,
    });

    expect(result).toMatchObject({ updated: 0, saved: 0, resources_with_changes: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        target: { kind: 'page', id: 'home' },
        reason: 'working_copy',
        fields: ['title'],
      }),
    ]);
    expect((await readWorkingCopy(context, { kind: 'page', id: 'home' }))?.fields).toEqual({ seo_title: 'Human draft' });
  });

  it('rejects fields and selectors outside the narrow repair contract', async () => {
    const { repairWordPressPlainText } = await import('../../lib/wp/plain-text-repair');
    await expect(repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      fields: ['html_content' as 'title'],
    })).rejects.toThrow('Invalid fields');
    await expect(repairWordPressPlainText(ORG, SITE, MAIN_VERSION_ID, {
      scope: 'pages',
      collection: 'services',
    })).rejects.toThrow('scope collection_items or all');
  });
});
