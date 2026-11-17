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

for (const mode of ['shared', 'session'] as const) for (const width of [375, 1280]) test(`Back and Forward restore ${mode} preview scroll without a second frame reload at ${width}px`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 800 });
  const id = `previewhistory${Date.now()}`;
  const ids = [id + 'a', id + 'b'];
  const root = mode === 'shared' ? '/preview/default' : '/api/sites/default/preview/browse';
  for (const [i, pageId] of ids.entries()) await e2eStore.set(`${DEFAULT_MAIN}/pages/${pageId}`, {
    title: i ? 'History second page' : 'History first page', slug: pageId, path: `/${pageId}/`,
    content_mode: 'html', status: 'published', content_type: 'page', fields: {},
    html_content: `<h2>${i ? 'Second' : 'First'} history page</h2><div style="height:1600px"></div><a href="/${ids[1]}/?choice=one#target">Next history page</a><h2 id="target">History target</h2><div style="height:1600px"></div>`,
  });
  try {
    const response = await page.request.post('/api/sites/default/preview-link', { headers: { Origin: new URL(baseURL!).origin }, data: { path: ids[0] } });
    expect(response.status()).toBe(200);
    const { url } = await response.json() as { url: string };
    const rendered = page.waitForResponse(response => { const u = new URL(response.url()); return u.pathname.includes(ids[0]!) && u.searchParams.get('frame') === '1'; });
    await page.goto(mode === 'shared' ? url + '&consent=necessary' : `${root}/${ids[0]}/?consent=necessary`);
    const timing = (await rendered).headers()['server-timing'];
    expect(timing).toContain('preview_render;');
    expect(timing).toContain('preview_route;');
    const frame = page.frameLocator('#preview');
    const next = frame.getByRole('link', { name: 'Next history page' });
    await next.scrollIntoViewIfNeeded();
    const originalScroll = await frame.locator('body').evaluate(() => window.scrollY);
    expect(originalScroll).toBeGreaterThan(500);
    await next.click();
    await page.waitForURL(current => current.pathname.includes(ids[1]!) && current.hash === '#target');
    await expect(frame.getByRole('heading', { name: 'Second history page' })).toBeAttached();
    await expect.poll(() => frame.locator('#target').evaluate(element => Math.abs(element.getBoundingClientRect().top))).toBeLessThan(100);
    expect(new URL(page.url()).searchParams.get('choice')).toBe('one');
    expect(new URL(page.url()).searchParams.get('consent')).toBe('necessary');
    expect(await frame.locator('body').evaluate(() => { try { return window.localStorage.length; } catch { return 'isolated'; } })).toBe('isolated');

    let backFrameRequests = 0;
    page.on('request', request => { const u = new URL(request.url()); if (u.pathname.includes(ids[0]!) && u.searchParams.get('frame') === '1') backFrameRequests++; });
    await page.goBack();
    await page.waitForURL(current => current.pathname.includes(ids[0]!));
    await expect(frame.getByRole('heading', { name: 'First history page' })).toBeAttached();
    await expect.poll(() => frame.locator('body').evaluate(() => window.scrollY)).toBeGreaterThan(originalScroll - 10);
    // Catch the former post-restoration replacement, rather than accepting
    // the browser's briefly correct first paint before popstate reloads it.
    await page.waitForTimeout(500);
    expect(Math.abs(await frame.locator('body').evaluate(() => window.scrollY) - originalScroll)).toBeLessThan(10);
    expect(backFrameRequests).toBeLessThanOrEqual(1);
    await page.goForward();
    await page.waitForURL(current => current.pathname.includes(ids[1]!));
    await expect(frame.getByRole('heading', { name: 'Second history page' })).toBeAttached();
    // A page opened at a fragment can subsequently be scrolled elsewhere.
    // Back must restore that later scroll, not jump to the original fragment.
    await frame.locator('body').evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => frame.locator('body').evaluate(() => window.scrollY)).toBe(400);
    await frame.getByRole('link', { name: 'Next history page' }).evaluate((element, href) => { element.setAttribute('href', href); (element as HTMLAnchorElement).click(); }, `${root}/${ids[0]}/`);
    await page.waitForURL(current => current.pathname.includes(ids[0]!));
    await expect(frame.getByRole('heading', { name: 'First history page' })).toBeAttached();
    await page.goBack();
    await page.waitForURL(current => current.pathname.includes(ids[1]!));
    await expect(frame.getByRole('heading', { name: 'Second history page' })).toBeAttached();
    await expect.poll(() => frame.locator('body').evaluate(() => window.scrollY)).toBe(400);
  } finally { for (const pageId of ids) await e2eStore.deleteTree(`${DEFAULT_MAIN}/pages/${pageId}`); }
});
