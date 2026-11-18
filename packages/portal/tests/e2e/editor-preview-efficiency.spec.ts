import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_MAIN, e2eStore, PORTAL_ORIGIN } from './helpers/store';

test('metadata edits share a draft request and Save refreshes the canvas once', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const id = 'preview-efficiency', doc = `${DEFAULT_MAIN}/pages/${id}`, wc = `/api/sites/default/working-copy/page/${id}`;
  await e2eStore.set(doc, { id, title: 'Preview efficiency', slug: id, path: `/${id}/`, status: 'draft', content_mode: 'blocks', blocks: [{ id: 'copy', type: 'core/prose', data: { html: '<p>Visible content.</p>' } }] });
  let drafts = 0, previews = 0;
  try {
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    await page.getByRole('button', { name: 'Page settings', exact: true }).click();
    await expect(page.frameLocator('iframe').first().getByText('Visible content.', { exact: true })).toBeVisible();
    page.on('request', request => {
      if (request.url().endsWith(wc) && request.method() === 'PUT') drafts++;
      if (/\/api\/sites\/default\/preview\//.test(request.url()) && request.resourceType() === 'document') previews++;
    });
    const saved = page.waitForResponse(response => response.url().endsWith(wc) && response.request().method() === 'PUT');
    await page.locator('#block-seo-title').fill('Sharing and search title');
    await page.locator('#block-meta-description').fill('Search description');
    await saved;
    // Covers the refresh debounce; head-only edits must not navigate the frame.
    await page.waitForTimeout(350);
    expect(drafts).toBe(1); expect(previews).toBe(0);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => previews).toBe(1);
    await page.waitForTimeout(350);
    expect(previews).toBe(1);
    expect((await e2eStore.read(doc)).seo_title).toBe('Sharing and search title');
  } finally {
    await page.goto('about:blank');
    await page.request.delete(wc, { headers: { Origin: PORTAL_ORIGIN } });
    await e2eStore.deleteTree(doc);
  }
});

test('HTML metadata autosave sends one changed field and Save does not resend the body', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const id = 'html-preview-efficiency', doc = `${DEFAULT_MAIN}/pages/${id}`, wc = `/api/sites/default/working-copy/page/${id}`;
  const body = '<p>Keep this HTML body.</p>';
  await e2eStore.set(doc, { id, title: 'HTML efficiency', slug: id, path: `/${id}/`, status: 'draft', content_mode: 'html', html_content: body });
  const patches: unknown[] = [];
  try {
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    await page.getByRole('button', { name: 'SEO', exact: true }).click();
    page.on('request', request => {
      if (request.url().endsWith(wc) && request.method() === 'PUT') patches.push(request.postDataJSON());
    });
    const saved = page.waitForResponse(response => response.url().endsWith(wc) && response.request().method() === 'PUT');
    await page.locator('#html-og-title').fill('Sharing title');
    await saved;
    expect(patches).toEqual([{ fields: { og_title: 'Sharing title' } }]);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await e2eStore.read(doc)).og_title).toBe('Sharing title');
    expect(patches).toHaveLength(1);
    expect((await e2eStore.read(doc)).html_content).toBe(body);
  } finally {
    await page.goto('about:blank');
    await page.request.delete(wc, { headers: { Origin: PORTAL_ORIGIN } });
    await e2eStore.deleteTree(doc);
  }
});
