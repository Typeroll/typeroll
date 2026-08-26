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

async function seedPage(id: string, html: string, status = 'published'): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id,
    slug: id,
    content_mode: 'html',
    status,
    html_content: html,
  });
}

describe('getBlockUsage', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('returns the pages that embed the named block', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" />');
    await seedPage('about', '<p>about</p>');
    await seedPage('pricing', '<section><x-include name="cta"></x-include></section>');

    const { getBlockUsage } = await import('../../lib/partials-usage');
    const usage = await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'cta');
    expect(usage.map((u) => u.page_id).sort()).toEqual(['home', 'pricing']);
    expect(usage[0]).toMatchObject({ page_id: expect.any(String), title: expect.any(String), slug: expect.any(String) });
  });

  it('returns empty for unknown ids', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" />');
    const { getBlockUsage } = await import('../../lib/partials-usage');
    const usage = await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'nope');
    expect(usage).toEqual([]);
  });

  it('escapes regex metachars in the block id', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" />');
    const { getBlockUsage } = await import('../../lib/partials-usage');
    expect(await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, '.*')).toEqual([]);
    expect(await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, '')).toEqual([]);
  });
});

describe('getAllBlockUsage', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('builds the full reverse index in one pass', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" /><x-include name="newsletter" />');
    await seedPage('about', '<x-include name="newsletter" />');
    await seedPage('pricing', '<p>no blocks here</p>');

    const { getAllBlockUsage } = await import('../../lib/partials-usage');
    const map = await getAllBlockUsage(ORG, SITE, MAIN_VERSION_ID);

    expect(map.get('cta')?.map((u) => u.page_id).sort()).toEqual(['home']);
    expect(map.get('newsletter')?.map((u) => u.page_id).sort()).toEqual(['about', 'home']);
    expect(map.get('pricing')).toBeUndefined();
  });

  it('deduplicates a block referenced multiple times on the same page', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" /><div></div><x-include name="cta" />');
    const { getAllBlockUsage } = await import('../../lib/partials-usage');
    const map = await getAllBlockUsage(ORG, SITE, MAIN_VERSION_ID);
    expect(map.get('cta')?.length).toBe(1);
  });
});

describe('listBlocksUsedInHtml', () => {
  it('returns the unique block ids referenced in the html', async () => {
    const { listBlocksUsedInHtml } = await import('../../lib/partials-usage');
    expect(listBlocksUsedInHtml('<p>no blocks</p>')).toEqual([]);
    expect(
      listBlocksUsedInHtml('<x-include name="cta" /><x-include name="newsletter"></x-include><x-include name="cta" />'),
    ).toEqual(['cta', 'newsletter']);
  });
});
