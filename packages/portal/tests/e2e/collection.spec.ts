/**
 * The organization collection on the default site (dev session, bundled fixtures):
 *   - Typeroll's built-in starters are listed, read-only
 *   - save a site block template to the collection from the Collection page
 *   - insert it into the site's library and into a page; the reports link to
 *     what was created and to the page
 */
import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_MAIN, PORTAL_ORIGIN, e2eStore } from './helpers/store';

test('save a template to the collection and insert it into the library and a page', async ({ page }, info) => {
  const name = `E2E collection hero ${Date.now() % 100000}`;
  const pageFile = `${DEFAULT_MAIN}/pages/collection-target`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.request.delete('/api/sites/default/working-copy/page/collection-target', { headers: { Origin: PORTAL_ORIGIN } });
  await e2eStore.set(pageFile, { id: 'collection-target', title: 'Collection target', slug: 'collection-target', status: 'draft', content_mode: 'blocks', blocks: [
    { id: 'intro', type: 'core/heading', data: { text: 'Intro', level: 'h2' } },
  ] });
  const created = await page.request.post('/api/sites/default/block-templates', {
    headers: { Origin: PORTAL_ORIGIN },
    data: { name, kind: 'section', category: 'Heroes', blocks: [{ id: 'h', type: 'core/rich_heading', data: { html: 'Welcome', style_id: 'eyebrow' } }] },
  });
  expect(created.ok()).toBe(true);
  const template = (await created.json()).block_template;
  const templateIds: string[] = [template.id];
  const entryIds: string[] = [];
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, '/app/sites/default/collection');
    await expect(page.getByRole('heading', { name: 'Collection', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Collection' })).toBeVisible();

    // Built-ins are listed and read-only.
    await page.getByRole('button', { name: 'Typeroll', exact: true }).click();
    const builtin = page.getByRole('article', { name: 'Feature page' });
    await expect(builtin).toBeVisible();
    await expect(builtin.getByText('Read-only')).toBeVisible();
    await expect(builtin.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.getByRole('button', { name: 'All', exact: true }).click();

    // Save the site template to the collection.
    await page.getByRole('button', { name: 'Save from this site…' }).click();
    await page.getByLabel('What to save').selectOption({ label: name });
    await page.getByLabel('Category').fill('E2E');
    await page.getByRole('button', { name: 'Save to collection' }).click();
    await expect(page.getByText(`Saved “${name}” to the collection.`)).toBeVisible();
    const listed = await page.request.get('/api/sites/default/collection');
    const saved = ((await listed.json()).entries as Array<{ id: string; name: string }>).find(item => item.name === name);
    expect(saved).toBeTruthy();
    entryIds.push(saved!.id);

    const card = page.getByRole('article', { name });
    await page.getByRole('searchbox').fill(name);
    await expect(card).toBeVisible();

    // Into the site's library: a new template (the id is taken, so it is renamed).
    await card.getByRole('button', { name: 'Add to this site’s templates' }).click();
    const report = page.locator('.pk-report');
    await expect(report.getByText(`Added ${name} to this site.`)).toBeVisible();
    await expect(report.getByRole('link', { name: /Block templates/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('collection-library-report.png'), fullPage: true });
    const templates = await page.request.get('/api/sites/default/block-templates');
    for (const item of (await templates.json()).block_templates as Array<{ id: string; name: string }>) {
      if (item.name.startsWith(name) && !templateIds.includes(item.id)) templateIds.push(item.id);
    }

    // Into a page: added at the end of its draft, with a link to the page.
    await card.getByRole('button', { name: 'Insert into a page…' }).click();
    await card.getByLabel('Page').selectOption('collection-target');
    await card.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(report.getByRole('link', { name: 'Collection target' })).toHaveAttribute('href', '/app/sites/default/pages/collection-target');
    const blocks = await page.request.get('/api/sites/default/pages/collection-target/blocks');
    const tree = (await blocks.json()).blocks as Array<{ id: string; type: string }>;
    expect(tree[0]!.id).toBe('intro');
    expect(tree.length).toBeGreaterThan(1);
  } finally {
    for (const id of entryIds) await page.request.delete(`/api/sites/default/collection/${id}`, { headers: { Origin: PORTAL_ORIGIN } });
    for (const id of templateIds) await page.request.delete(`/api/sites/default/block-templates/${id}`, { headers: { Origin: PORTAL_ORIGIN } });
    await page.request.delete('/api/sites/default/working-copy/page/collection-target', { headers: { Origin: PORTAL_ORIGIN } });
    await e2eStore.deleteTree(pageFile);
  }
});
