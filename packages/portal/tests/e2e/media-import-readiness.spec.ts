import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_SITE, e2eStore } from './helpers/store';

for (const width of [320, 1280]) test(`unfinished media stays inspectable without a broken preview at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const ids = ['ready', 'pending', 'failed'].map(state => `readiness-fixture-${state}`);
  const base = new URL(info.project.use.baseURL ?? 'http://127.0.0.1:4322').origin;
  const url = (id: string) => `${base}/api/sites/default/media/${id}/content`;
  const media = ids.map((id, index) => [
    `${DEFAULT_SITE}/media/${id}`,
    { filename: `${id}.jpg`, mime_type: 'image/jpeg', cdn_url: url(id), created_at: '2026-01-01T00:00:00Z',
      source_url: 'https://source.example.com/photo.jpg', import_pending: index !== 0, migration_failed: index === 2,
      storage: { state: index === 0 ? 'ready' : 'uploading', provider: 'organization_r2' },
      ...(index === 2 ? { migration_error: { code: 'media_source_unavailable', message: 'The source is unavailable.' } } : {}) },
  ] as [string, Record<string, unknown>]);
  const unreadyRequests: string[] = [];
  page.on('request', request => { if (ids.slice(1).some(id => request.url().startsWith(url(id)))) unreadyRequests.push(request.url()); });
  await page.route('**/api/sites/default/media/upload-status', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/sites/default/media/preparation', route => route.fulfill({ json: { state: 'complete', completed: 0, total: 0 } }));
  await page.route(url(ids[0]), route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64') }));
  await e2eStore.setMany(media);
  try {
    await gotoReady(page, '/app/sites/default/media');
    await page.getByRole('searchbox', { name: 'Search the media library' }).fill('readiness-fixture');
    await expect(page.locator('.media__item')).toHaveCount(3);
    await expect(page.getByRole('img', { name: 'File awaiting verification' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'File unavailable' })).toBeVisible();
    await expect(page.locator('.media__item img')).toHaveCount(1);
    await expect.poll(() => page.locator('.media__item img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: `View details for ${ids[2]}.jpg` }).click();
    const dialog = page.getByRole('dialog', { name: `Media: ${ids[2]}.jpg` });
    await dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    await expect(dialog.getByRole('alert')).toContainText('could not be imported or copied');
    await expect(dialog.getByText('No verified file is available for preview or selection.')).toBeVisible();
    await expect(dialog.getByText('Publish a page that uses this file to make it public.')).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: 'Open private preview' })).toHaveCount(0);
    await expect(dialog.locator('img')).toHaveCount(0);
    await expect(dialog.getByLabel('Public path', { exact: true })).toHaveValue('');
    await expect(dialog.getByPlaceholder('/photo.jpg')).toBeVisible();
    await expect(dialog.getByText('Leave blank to use the filename in the root.', { exact: false })).toBeVisible();
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: info.outputPath(`media-import-${width}.png`) });
    expect(unreadyRequests).toEqual([]);
    // Check the built Worker's editor API too, with the same local fixture.
    const refused = await page.request.put('/api/sites/default/working-copy/page/home', {
      headers: { Origin: base }, data: { fields: { og_image: url(ids[1]) } },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'media_not_ready', details: { media_id: ids[1], state: 'pending' } });
    const direct = await page.request.put('/api/sites/default/pages/home', {
      headers: { Origin: base }, data: { og_image: url(ids[2]) },
    });
    expect(direct.status()).toBe(409);
    expect(await direct.json()).toMatchObject({ code: 'media_not_ready', details: { media_id: ids[2], state: 'failed' } });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: `View details for ${ids[0]}.jpg` }).click();
    const ready = page.getByRole('dialog', { name: `Media: ${ids[0]}.jpg` });
    await ready.getByLabel('Public path', { exact: true }).fill('/products/photo.jpg');
    await ready.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(ready.getByText('Saved', { exact: true })).toBeVisible();
    expect((await e2eStore.read(`${DEFAULT_SITE}/media/${ids[0]}`)).public_path).toBe('/products/photo.jpg');
    await ready.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: `View details for ${ids[0]}.jpg` }).click();
    await expect(ready.getByLabel('Public path', { exact: true })).toHaveValue('/products/photo.jpg');
    await ready.getByLabel('Public path', { exact: true }).fill('');
    await ready.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(ready.getByText('Saved', { exact: true })).toBeVisible();
    expect((await e2eStore.read(`${DEFAULT_SITE}/media/${ids[0]}`)).public_path).toBeNull();

  } finally { await e2eStore.delete(...media.map(([path]) => path)); }
});
