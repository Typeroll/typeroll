import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Block, SiteVersion } from '@typeroll/shared';

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
    expect(usage.pages.map((u) => u.page_id).sort()).toEqual(['home', 'pricing']);
    expect(usage.pages[0]).toMatchObject({ page_id: expect.any(String), title: expect.any(String), slug: expect.any(String) });
    expect(usage.templates).toEqual([]);
    expect(usage.global_blocks).toEqual([]);
  });

  it('returns empty for unknown ids', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" />');
    const { getBlockUsage } = await import('../../lib/partials-usage');
    const usage = await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'nope');
    expect(usage).toEqual({ pages: [], templates: [], global_blocks: [] });
  });

  it('escapes regex metachars in the block id', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" />');
    const { getBlockUsage } = await import('../../lib/partials-usage');
    expect((await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, '.*')).pages).toEqual([]);
    expect((await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, '')).pages).toEqual([]);
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

    expect(map.get('cta')?.pages.map((u) => u.page_id).sort()).toEqual(['home']);
    expect(map.get('newsletter')?.pages.map((u) => u.page_id).sort()).toEqual(['about', 'home']);
    expect(map.get('pricing')).toBeUndefined();
  });

  it('deduplicates a block referenced multiple times on the same page', async () => {
    await setup();
    await seedPage('home', '<x-include name="cta" /><div></div><x-include name="cta" />');
    const { getAllBlockUsage } = await import('../../lib/partials-usage');
    const map = await getAllBlockUsage(ORG, SITE, MAIN_VERSION_ID);
    expect(map.get('cta')?.pages.length).toBe(1);
  });
});

const ref = (id: string, globalBlockId: string): Block => ({ id, type: 'core/global_block', data: { global_block_id: globalBlockId } });

async function seedPartial(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/${id}`, { name: id, kind: 'free', status: 'published', content_mode: 'blocks', blocks: [], ...doc });
}

async function seedDraft(kind: 'page' | 'partial', id: string, fields: Record<string, unknown>): Promise<void> {
  const { mergeWorkingCopy } = await import('../../lib/working-copy');
  await mergeWorkingCopy({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, { kind, id }, fields);
}

describe('usage beyond pages', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('lists page templates, header/footer and nesting global blocks, saved or drafted', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pageTemplates(ORG, SITE, MAIN_VERSION_ID)}/landing`, {
      name: 'landing', label: 'Landing', status: 'published', created_at: new Date().toISOString(),
      blocks: [{ id: 'sec', type: 'core/section', data: {}, children: [ref('r1', 'cta')] }],
    });
    await seedPartial('cta', { blocks: [{ id: 'h', type: 'core/heading', data: { text: 'Hi' } }] });
    // Nested: a global block that contains cta, inside a column slot.
    await seedPartial('promo', { name: 'Promo', blocks: [{ id: 'cols', type: 'core/columns', data: {}, slots: [[ref('r2', 'cta')], []] }] });
    // The header references cta only in its unsaved draft.
    await seedPartial('header', { name: 'Main Header', kind: 'header', blocks: [] });
    await seedDraft('partial', 'header', { blocks: [ref('r3', 'cta')] });
    // An HTML footer embeds it with <x-include>, which the renderer expands there.
    await seedPartial('footer', { name: 'Main Footer', kind: 'footer', content_mode: 'html', blocks: undefined, html_content: '<x-include name="cta" />' });
    // A self-reference is not a usage.
    await seedPartial('loop', { blocks: [ref('r4', 'loop')] });

    const { getBlockUsage, getAllBlockUsage, describeBlockUsage } = await import('../../lib/partials-usage');
    const usage = await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'cta');
    expect(usage.pages).toEqual([]);
    expect(usage.templates).toEqual([{ template_id: 'landing', label: 'Landing', status: 'published' }]);
    expect(usage.global_blocks.map(b => [b.partial_id, b.kind]).sort()).toEqual([['footer', 'footer'], ['header', 'header'], ['promo', 'free']]);
    expect(describeBlockUsage(usage)).toBe('used in 1 template and 3 global blocks');
    expect((await getAllBlockUsage(ORG, SITE, MAIN_VERSION_ID)).get('loop')).toBeUndefined();
  });

  it('counts a reference that exists only in a page draft, in blocks or HTML', async () => {
    await setup();
    await seedPage('home', '<p>saved without it</p>');
    await seedDraft('page', 'home', { html_content: '<x-include name="cta" />' });
    const { getBlockUsage, describeBlockUsage } = await import('../../lib/partials-usage');
    const usage = await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'cta');
    expect(usage.pages.map(p => p.page_id)).toEqual(['home']);
    expect(describeBlockUsage(usage)).toBe('used on 1 page');
  });
});

describe('describeBlockUsage', () => {
  it('names pages first and joins the rest', async () => {
    const { describeBlockUsage, emptyBlockUsage } = await import('../../lib/partials-usage');
    const page = { page_id: 'a', title: 'A', slug: 'a', status: 'published' };
    expect(describeBlockUsage(emptyBlockUsage())).toBe('used on 0 pages');
    expect(describeBlockUsage({ ...emptyBlockUsage(), pages: [page, { ...page, page_id: 'b' }] })).toBe('used on 2 pages');
    expect(describeBlockUsage({
      pages: [page],
      templates: [{ template_id: 't', label: 'T', status: 'published' }],
      global_blocks: [{ partial_id: 'header', name: 'Header', kind: 'header', status: 'published' }],
    })).toBe('used on 1 page, 1 template and 1 global block');
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
