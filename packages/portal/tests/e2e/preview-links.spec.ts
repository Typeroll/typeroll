/**
 * Links in a preview link: the page runs in a sandboxed frame without top
 * navigation, where an off-site link would otherwise end on a browser error
 * page. It opens in a new tab while the preview stays on the page; in-site
 * links keep navigating the preview with its ticket.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_MAIN, e2eStore } from './helpers/store';

const DOCS = 'https://docs.typeroll.test/blocks/reusable/';

test('an off-site link opens in a new tab and the preview stays on the page', async ({ page, baseURL }) => {
  const id = `e2epreviewlinks${Date.now()}`;
  const pageDoc = `${DEFAULT_MAIN}/pages/${id}`;
  const html = `<p><a href="${DOCS}">Reusable blocks ↗</a> <a href="/${id}/">This page</a></p>`;
  await e2eStore.set(pageDoc, {
    title: 'Preview links', slug: id, path: `/${id}`, content_mode: 'blocks', status: 'published',
    content_type: 'page', fields: {}, date_updated: new Date().toISOString(),
    blocks: [{ id: 'links', type: 'core/prose', data: { html } }],
  });
  try {
    // Offline: the destination is answered locally and never reaches the network.
    await page.context().route('https://docs.typeroll.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Docs</title><h1>Docs</h1>' }));
    const link = await page.request.post('/api/sites/default/preview-link', { headers: { Origin: new URL(baseURL!).origin }, data: { path: id } });
    expect(link.status(), await link.text()).toBe(200);
    const { url } = await link.json() as { url: string };

    // Answer the cookie banner up front so it never covers the links.
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}consent=necessary`);
    const frame = page.frameLocator('#preview');
    await expect(frame.getByRole('link', { name: 'Reusable blocks ↗' })).toBeVisible();
    const shellUrl = page.url();
    const frameUrl = page.frames()[1]!.url();

    const popup = page.context().waitForEvent('page');
    await frame.getByRole('link', { name: 'Reusable blocks ↗' }).click();
    const tab = await popup;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(DOCS);
    // Opened by the shell, not the sandboxed frame: the tab is not sandboxed.
    expect(await tab.evaluate(() => { try { return typeof window.localStorage; } catch { return 'denied'; } })).toBe('object');
    expect(await tab.evaluate(() => window.opener)).toBeNull();

    expect(page.url()).toBe(shellUrl);
    expect(page.frames()[1]!.url()).toBe(frameUrl);
    await expect(frame.getByRole('link', { name: 'This page' })).toBeVisible();

    // In-site links still move the shell and keep the ticket.
    await frame.getByRole('link', { name: 'This page' }).click();
    await page.waitForURL((current) => current.pathname === `/preview/default/${id}/` && current.searchParams.has('t'));
    expect(page.context().pages()).toHaveLength(2);
  } finally {
    await e2eStore.deleteTree(pageDoc);
  }
});
