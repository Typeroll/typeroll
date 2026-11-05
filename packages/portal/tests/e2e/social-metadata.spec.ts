import { test, expect } from '@playwright/test';
import { gotoReady, reloadReady } from './helpers/ready';
import { DEFAULT_MAIN, e2eStore } from './helpers/store';

for (const mode of ['blocks', 'html'] as const) {
  for (const width of [390, 1440]) {
    test(`${mode} sharing overrides persist independently of SEO at ${width}px`, async ({ page }, testInfo) => {
      const id = `social-${mode}-${width}`;
      const pageDoc = `${DEFAULT_MAIN}/pages/${id}`;
      await e2eStore.set(pageDoc, { id, title: 'Document title', slug: id, path: `/${id}/`, status: 'draft',
        content_mode: mode, seo_title: 'Search title', seo_description: 'Search description',
        blocks: [{ id: 'intro', type: 'core/text', data: { html: '<p>Page content</p>' } }], html_content: '<p>Page content</p>' });
      async function openSettings() {
        if (mode === 'blocks') await page.getByRole('button', { name: 'Page settings', exact: true }).click();
        else {
          if (width < 768) await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('button', { name: 'Edit', exact: true }).click();
          await page.getByRole('button', { name: 'SEO', exact: true }).click();
        }
      }
      try {
        await page.setViewportSize({ width, height: 900 });
        await gotoReady(page, `/app/sites/default/pages/${id}`);
        await openSettings();
        await page.getByLabel('Sharing title', { exact: true }).fill('Share this page');
        await page.getByLabel('Sharing description', { exact: true }).fill('A description for social sharing');
        await page.getByLabel('Sharing title', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('sharing-fields.png') });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expect(page.getByText(/Unsaved changes/).first()).toBeVisible();
        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
        await reloadReady(page);
        await openSettings();
        await expect(page.getByLabel('Sharing title', { exact: true })).toHaveValue('Share this page');
        await expect(page.getByLabel('Sharing description', { exact: true })).toHaveValue('A description for social sharing');
        expect(await e2eStore.read(pageDoc)).toMatchObject({ seo_title: 'Search title', seo_description: 'Search description', og_title: 'Share this page', og_description: 'A description for social sharing' });
      } finally { await e2eStore.deleteTree(pageDoc); }
    });
  }
}
