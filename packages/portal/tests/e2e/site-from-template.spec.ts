/**
 * A new site from another site of the organization (dev session):
 *   - the New site page offers "Start from a template or another site"
 *   - choosing a site of the default organization previews what it brings
 *   - creating copies its pages (a block page and an HTML page), header and
 *     menu, then opens the new site's overview
 *
 * The local E2E Worker has no media storage, so the source is a small site
 * of its own without media files; copying media is covered by the offline
 * portal tests (site-from-template.test.ts).
 */
import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { e2eStore } from './helpers/store';

test('create a site as a copy of another site and see its pages', async ({ page }, info) => {
  const run = Date.now() % 100000;
  const source = `tpl-source-${run}`;
  const name = `Template copy ${run}`;
  const root = `organizations/default/sites/${source}`;
  const main = `${root}/versions/main`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await e2eStore.setMany([
    [root, { name: `Template source ${run}`, created_at: new Date().toISOString(), media_id: `tpl${run}`.slice(0, 10), publishing_mode: 'customer', hosting_adapter: 'cloudflare', hosting_group_id: 'default' }],
    [`${main}/settings/default`, { site_name: `Template source ${run}`, language: 'en', colors: { primary: '#0a6b45', secondary: '#1e293b', accent: '#f59e0b', background: '#ffffff', surface: '#f8fafc', text: '#0f172a', text_light: '#64748b' }, fonts: { heading: 'Inter', body: 'Inter', size_base: 16 }, render_version: 14, scripts_head: '<script>window.__sourceTracker = true;</script>' }],
    [`${main}/pages/home`, { title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [{ id: 'h1', type: 'core/heading', data: { text: 'Welcome to the template', level: 'h1' } }] }],
    [`${main}/pages/about`, { title: 'About us', slug: 'about', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [{ id: 'a1', type: 'core/heading', data: { text: 'About us', level: 'h1' } }] }],
    [`${main}/pages/contact`, { title: 'Contact', slug: 'contact', content_type: 'page', content_mode: 'html', status: 'draft', html_content: '<h1>Contact</h1><p>Write to us.</p>' }],
    [`${main}/partials/header`, { name: 'Header', kind: 'header', content_mode: 'blocks', status: 'published', blocks: [{ id: 'hd', type: 'core/heading', data: { text: 'Template header', level: 'h2' } }] }],
    [`${main}/menus/main`, { name: 'Main', locations: ['primary'], items: [{ id: 'i1', type: 'page', page_id: 'about' }, { id: 'i2', type: 'page', page_id: 'contact' }], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
  ]);

  await page.setViewportSize({ width: 1280, height: 1000 });
  await gotoReady(page, '/app/sites/new');
  const card = page.getByRole('region', { name: 'Start from a template or another site' });
  await expect(card).toBeVisible();
  await card.getByLabel('Site name').fill(name);
  await card.getByRole('radio', { name: /Another site of this organization/ }).check();
  await card.getByLabel('Site to copy').selectOption(source);
  // The preview names the source and what it brings, and what is not copied.
  await expect(card.getByText('3 pages, 1 global block, 1 menu, 0 media files')).toBeVisible();
  await expect(card.getByText(/Custom scripts .* are not copied/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('site-from-template-preview.png'), fullPage: true });

  await card.getByRole('button', { name: 'Create site from this' }).click();
  // The notes say what was not copied; then the new site opens.
  const ready = page.getByRole('region', { name: 'Your new site is ready' });
  await expect(ready).toBeVisible({ timeout: 30_000 });
  await expect(ready.getByRole('note', { name: 'Before you publish' })).toContainText('Custom scripts');
  await ready.getByRole('link', { name: 'Open the new site' }).click();
  await expect(page).toHaveURL(/\/app\/sites\/template-copy-\d+$/);
  const siteId = new URL(page.url()).pathname.split('/').pop()!;

  await gotoReady(page, `/app/sites/${siteId}/pages`);
  await expect(page.getByRole('link', { name: 'About us' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Contact' }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('site-from-template-pages.png'), fullPage: true });

  // What was copied, and what was not.
  const copy = `organizations/default/sites/${siteId}/versions/main`;
  expect(await e2eStore.get(`${copy}/pages/contact`)).toMatchObject({ content_mode: 'html', status: 'draft' });
  expect(await e2eStore.get(`${copy}/partials/header`)).toMatchObject({ kind: 'header' });
  expect(await e2eStore.get(`${copy}/menus/main`)).toMatchObject({ items: [{ page_id: 'about' }, { page_id: 'contact' }] });
  const settings = await e2eStore.read(`${copy}/settings/default`);
  expect(settings).toMatchObject({ site_name: name, render_version: 14, colors: { primary: '#0a6b45' } });
  expect(settings.scripts_head).toBeUndefined();
});
