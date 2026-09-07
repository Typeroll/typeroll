import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.use({ hasTouch: true });

const version = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main');

async function fits(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
  test(`block editor supports editing and saving at ${width}x${height}`, async ({ page }, testInfo) => {
    const id = `mobile-editor-${width}`;
    const file = path.join(version, `pages/${id}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ id, title: 'A long mobile page title that should stay readable', slug: id, path: `/${id}/`,
      status: 'draft', content_mode: 'blocks', blocks: [{ id: 'mobile-heading', type: 'core/heading', data: { text: 'Original heading', level: 'h1' } }] }));
    try {
      await page.setViewportSize({ width, height });
      await page.goto(`/app/sites/default/pages/${id}`, { waitUntil: 'networkidle' });
      await fits(page, '.pmenu__trigger');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const panels = page.getByRole('navigation', { name: 'Editor panels' });
      await panels.getByRole('button', { name: 'Blocks', exact: true }).click();
      await page.getByRole('button', { name: 'Structure', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Original heading', exact: true }).click();
      const field = page.getByLabel('Heading text', { exact: true });
      await expect(field).toBeVisible();
      await field.fill('Edited on mobile');
      await page.getByLabel('Level (semantic)', { exact: true }).selectOption('h2');
      await expect(page.locator('.block-editor__status')).toContainText('Unsaved changes — save via Publish');
      await panels.getByRole('button', { name: 'Blocks', exact: true }).tap();
      await page.getByRole('button', { name: 'Add', exact: true }).tap();
      await page.screenshot({ path: testInfo.outputPath(`mobile-library-${width}.png`) });
      await page.getByRole('button', { name: 'Text', exact: true }).tap();
      await page.getByLabel('Content', { exact: true }).fill('<p>Added with touch</p>');
      await expect(page.locator('.block-editor__status')).toContainText('Unsaved changes');
      await page.getByRole('button', { name: 'Page settings', exact: true }).click();
      await page.getByLabel('Page title', { exact: true }).fill('Mobile draft title');
      await fits(page, '.block-editor__fields');
      await page.screenshot({ path: testInfo.outputPath(`mobile-fields-${width}.png`) });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await fits(page, '.pmenu__panel');
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await fits(page, '[role="dialog"]');
      await expect(page.frameLocator('iframe[title="Saved version"]').getByRole('heading', { name: 'Original heading', exact: true })).toBeVisible();
      await expect(page.frameLocator('iframe[title="Utkast"]').getByText('Added with touch', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`mobile-review-${width}.png`) });
      await page.getByRole('button', { name: 'Close (Esc)', exact: true }).click();
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close publishing menu', exact: true }).click();
      await panels.getByRole('button', { name: 'Preview', exact: true }).click();
      await fits(page, '.block-editor__preview');
      const preview = page.frameLocator('iframe[title="Preview"]');
      await expect(preview.getByRole('heading', { name: 'Edited on mobile', level: 2, exact: true })).toBeVisible();
      await expect(preview.getByText('Added with touch', { exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.block-editor__status')).toContainText('Saved · draft');
      await page.screenshot({ path: testInfo.outputPath(`mobile-preview-${width}.png`) });
      // A larger screen restores simultaneous panels without losing editor state.
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.locator('.block-editor__blocks')).toBeVisible();
      await expect(page.locator('.block-editor__fields')).toBeVisible();
      await expect(page.locator('.block-editor__preview')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`desktop-restored-${width}.png`) });
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.locator('.block-editor__status')).toContainText('Saved · draft');
      await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Mobile draft title');
      await expect(page.frameLocator('iframe[title="Preview"]').getByRole('heading', { name: 'Edited on mobile', level: 2, exact: true })).toBeVisible();
    } finally { rmSync(file, { force: true }); }
  });
}

test('HTML editor fits a phone and switches between editing and preview', async ({ page }, testInfo) => {
  const file = path.join(version, 'pages/mobile-html-editor.json');
  writeFileSync(file, JSON.stringify({ id: 'mobile-html-editor', title: 'HTML mobile page', slug: 'mobile-html-editor',
    path: '/mobile-html-editor/', status: 'draft', content_mode: 'html', html_content: '<h1>HTML mobile preview</h1>' }));
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/app/sites/default/pages/mobile-html-editor', { waitUntil: 'networkidle' });
    await fits(page, '.pmenu__trigger');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const panels = page.getByRole('navigation', { name: 'Editor panels' });
    await panels.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'SEO', exact: true }).click();
    await fits(page, '.editor__sidebar');
    await page.screenshot({ path: testInfo.outputPath('html-mobile-edit.png') });
    await panels.getByRole('button', { name: 'Preview', exact: true }).click();
    await fits(page, '.editor__preview-pane');
    await expect(page.frameLocator('iframe[title="Page preview"]').getByRole('heading', { name: 'HTML mobile preview', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('html-mobile-preview.png') });
  } finally { rmSync(file, { force: true }); }
});
