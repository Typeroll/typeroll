import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths, type Block } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ctx = { orgId: 'orgone', siteId: 'mysite', versionId: MAIN_VERSION_ID };
const heading: Block = { id: 'body-title', type: 'core/heading', data: { level: 'h1', text: 'Body title' } };

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ctx.orgId, ctx.siteId), { name: 'Test site' });
  await store.setDoc(paths.version(ctx.orgId, ctx.siteId, MAIN_VERSION_ID), { name: 'Main', kind: 'main' });
  await store.setDoc(paths.contentType(ctx.orgId, ctx.siteId, 'article'), { id: 'article', name: 'Article', fields: [], template: 'article', route_template: '/{slug}' });
  await store.setDoc(paths.pageTemplate(ctx.orgId, ctx.siteId, 'article'), { id: 'article', name: 'Article', blocks: [
    { id: 'title', type: 'template/page_title', data: {} },
    { id: 'body', type: 'template_content_slot', data: {} },
    { id: 'toc', type: 'core/table_of_contents', data: { levels: 'h2-h3' } },
  ] });
});

describe('Page heading write and preview boundaries', () => {
  it('rejects duplicate H1 at creation before persisting a Page', async () => {
    const { createPage } = await import('../../lib/page-create');
    await expect(createPage(ctx, { title: 'Test', content_type: 'article', blocks: [heading] }, 'portal', 'editor')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Page template already provides') });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.pages(ctx.orgId, ctx.siteId))).toEqual([]);
  });
  it('blocks editor Save, preserves the draft for correction, then accepts H2', async () => {
    const { createPage } = await import('../../lib/page-create');
    const { page } = await createPage(ctx, { title: 'Test', content_type: 'article', blocks: [] }, 'portal', 'editor');
    const target = { kind: 'page' as const, id: page.id };
    const { mergeWorkingCopy, commitWorkingCopy, readWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(ctx, target, { blocks: [heading] });
    await expect(commitWorkingCopy(ctx, target, 'editor')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Change body H1') });
    expect(await readWorkingCopy(ctx, target)).not.toBeNull();
    await mergeWorkingCopy(ctx, target, { blocks: [{ ...heading, data: { ...heading.data, level: 'h2' } }] });
    await commitWorkingCopy(ctx, target, 'editor');
    expect(await readWorkingCopy(ctx, target)).toBeNull();
  });
  it('renders legacy duplicate headings as one H1 without changing stored content', async () => {
    const { getStore } = await import('../../lib/datastore');
    const path = paths.page(ctx.orgId, ctx.siteId, 'test');
    await getStore().setDoc(path, { id: 'test', title: 'Template title', slug: 'test', content_type: 'article', content_mode: 'blocks', status: 'published', blocks: [heading] });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ctx.orgId, ctx.siteId, 'test', MAIN_VERSION_ID);
    expect(html?.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h2\b[^>]*>Body title<\/h2>/);
    expect(html).toContain('href="#body-title"');
    expect((await getStore().getDoc<any>(path))?.blocks[0].data.level).toBe('h1');
  });
});

it('respects a Page template override and rejects multiple template H1 headings', async () => {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.pageTemplate(ctx.orgId, ctx.siteId, 'body-only'), { id: 'body-only', name: 'Body only', applies_to: 'any', blocks: [{ id: 'slot', type: 'template_content_slot', data: {} }] });
  const { createPage } = await import('../../lib/page-create');
  const { page } = await createPage(ctx, { title: 'Own title', content_type: 'article', template: 'body-only', blocks: [heading] }, 'portal', 'editor');
  expect(page.blocks?.[0].data.level).toBe('h1');
  const { savePageTemplate } = await import('../../lib/page-template-service');
  await expect(savePageTemplate(ctx, 'bad', { label: 'Bad', applies_to: 'any', blocks: [heading, { id: 'rich', type: 'core/rich_heading', data: { html: 'Another title', level: 'h1' } }] }, true)).rejects.toThrow('only one H1');
});
