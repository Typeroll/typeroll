import { test, expect } from '@playwright/test';
import { DEFAULT_MAIN, e2eStore, PORTAL_ORIGIN } from './helpers/store';
import { gotoReady } from './helpers/ready';

test('isolated origin keeps the actual editor and shared preview working without portal authority', async ({ page }) => {
  test.skip(process.env.TYPEROLL_E2E_ISOLATED_PREVIEW !== 'true', 'Run with TYPEROLL_E2E_ISOLATED_PREVIEW=true');
  const id = 'isolated-preview', doc = `${DEFAULT_MAIN}/pages/${id}`;
  let asset: string | undefined;
  page.on('response', response => { const url = new URL(response.url()); if (!asset && url.origin === PORTAL_ORIGIN && url.pathname.startsWith('/_astro/')) asset = url.pathname; });
  await page.route('https://www.youtube.com/embed/isolated-preview-test', route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': 'frame-ancestors *' }, body: '<label>Name <input></label><button>Continue</button>' }));
  await e2eStore.set(doc, { title: 'Isolated preview', slug: id, path: `/${id}/`, content_mode: 'blocks', status: 'draft', blocks: [
    { id: 'heading', type: 'core/heading', data: { text: 'Original heading', level: 'h2' } },
    { id: 'partner', type: 'core/embed', data: { html: '<iframe title="Partner form" src="https://www.youtube.com/embed/isolated-preview-test" style="width:100%;height:140px"></iframe>' } },
  ] });
  try {
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    const iframe = page.locator('iframe[title="Preview"]');
    await expect(iframe).toBeVisible();
    const preview = iframe.contentFrame();
    await expect(preview.getByRole('heading', { name: 'Original heading' })).toBeVisible();
    await expect(preview.frameLocator('iframe[title="Partner form"]').getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(preview.getByText('External embed · www.youtube.com')).toBeVisible();
    await preview.getByText('External embed · www.youtube.com').click();
    await expect(preview.getByText(/Typeroll cannot confirm/)).toBeVisible();
    const frame = await iframe.elementHandle().then(handle => handle!.contentFrame());
    const origin = new URL(frame!.url()).origin;
    expect(origin).not.toBe(PORTAL_ORIGIN);
    expect(new URL(origin).hostname).toMatch(/^[a-f0-9]{32}\.localhost$/);
    expect(await frame!.evaluate(() => { try { return parent.document.title; } catch { return 'isolated'; } })).toBe('isolated');
    await preview.getByRole('heading', { name: 'Original heading' }).click();
    // A canvas click must reach the parent through the exact-origin bridge.
    await expect(page.getByRole('heading', { name: 'Heading', level: 3, exact: true })).toBeVisible();
    const heading = preview.locator('[data-edit="heading:text"]');
    await heading.dblclick();
    await heading.fill('Edited isolated heading');
    await heading.press('Enter');
    await expect.poll(async () => JSON.stringify((await (await page.request.get(`/api/sites/default/working-copy/page/${id}`)).json()).working_copy)).toContain('Edited isolated heading');
    expect(asset).toBeTruthy();
    for (const path of ['/api/auth/get-session', '/api/v1/sites', '/app', ...(asset ? [new URL(asset, PORTAL_ORIGIN).pathname] : [])]) {
      const response = await page.request.get(origin + path);
      expect(response.status()).toBe(404);
      expect(response.headers()['set-cookie']).toBeUndefined();
    }
    const minted = await page.request.post('/api/sites/default/preview-link', { headers: { Origin: PORTAL_ORIGIN }, data: { path: id } });
    expect(minted.status()).toBe(200);
    const link = await minted.json();
    expect(new URL(link.url).origin).toBe(origin);
    await page.goto(link.url + '&consent=necessary');
    await expect(page.frameLocator('#preview').getByRole('heading', { name: 'Original heading' })).toBeVisible();
    await page.screenshot({ path: '/tmp/typeroll-isolated-portal-preview.png', fullPage: true });
  } finally { await page.goto('about:blank'); await page.request.delete(`/api/sites/default/working-copy/page/${id}`, { headers: { Origin: PORTAL_ORIGIN } }); await e2eStore.deleteTree(doc); }
});
