import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main');
const pageFile = path.join(root, 'pages/render-v2.json');
const settingsFile = path.join(root, 'settings/default.json');

test('render version 2: heading parts with styles, class on the element and paragraph styles', async ({ page }, info) => {
  const originalSettings = readFileSync(settingsFile, 'utf8');
  mkdirSync(path.dirname(pageFile), { recursive: true });
  writeFileSync(pageFile, JSON.stringify({
    id: 'render-v2', title: 'Render v2', slug: 'render-v2', status: 'draft', content_mode: 'blocks',
    blocks: [
      { id: 'title', name: 'Hero heading', type: 'core/heading', data: { text: 'AI partner', level: 'h1', eyebrow: 'For leadership teams' } },
      { id: 'intro', name: 'Intro text', type: 'core/prose', data: { html: '<p>One day to a plan.</p>' } },
      { id: 'legacy', name: 'Legacy text', type: 'core/prose', data: { html: '<p class="kicker">How it works</p><h2>Three steps</h2><p>Body copy.</p>' } },
    ],
  }));
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(originalSettings), render_version: 2 }));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/app/sites/default/styles', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add standard styles' }).click();
    await expect(page.getByRole('status')).toContainText(/Added \d+ standard styles|already here/);

    await page.goto('/app/sites/default/pages/render-v2', { waitUntil: 'networkidle' });
    const preview = page.frameLocator('iframe[title="Preview"]');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();

    // Eyebrow and subtitle are part of the heading block, each with a style.
    await page.getByRole('button', { name: 'Edit Hero heading', exact: true }).click();
    await page.getByLabel('Subtitle', { exact: true }).fill('One day to a plan');
    await expect(page.getByLabel('Eyebrow style', { exact: true })).toContainText('Site default (Eyebrow)');
    await expect(page.getByLabel('Block anchor id')).toHaveCount(0);
    await page.getByLabel('Eyebrow style', { exact: true }).selectOption({ label: 'Eyebrow' });
    const group = preview.locator('hgroup.block-heading-group');
    await expect(group.locator('p.block-heading-eyebrow.s-eyebrow')).toHaveText('For leadership teams');
    await expect(group.locator('p.block-heading-subtitle')).toHaveText('One day to a plan');
    await expect(group.locator('p.block-heading-eyebrow')).toHaveCSS('opacity', '1');
    await expect(group.locator('p.block-heading-eyebrow')).toHaveCSS('text-transform', 'uppercase');

    // A custom class lands on the <h1> itself.
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByLabel('CSS class', { exact: true }).fill('hero-title');
    await page.getByLabel('CSS class', { exact: true }).press('Tab');
    await expect(preview.getByRole('heading', { level: 1, name: 'AI partner' })).toHaveClass(/\bhero-title\b/);
    await page.waitForTimeout(1500); // let the preview finish reloading for the screenshot
    await page.screenshot({ path: info.outputPath('heading-v2-1440.png') });

    // Paragraph styles apply the site's text styles to a whole paragraph.
    await page.getByRole('button', { name: 'Edit Intro text', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Content', exact: true });
    await editor.click();
    await page.getByLabel('Paragraph style', { exact: true }).selectOption({ label: 'Lead' });
    await expect(preview.locator('p.s-lead')).toHaveText('One day to a plan.');

    // Unknown markup is edited as source; there is no conversion into blocks.
    await page.getByRole('button', { name: 'Edit Legacy text', exact: true }).click();
    await expect(page.getByText('so it is edited as source')).toBeVisible();
    await expect(page.getByRole('button', { name: /Convert/ })).toHaveCount(0);
  } finally {
    rmSync(pageFile, { force: true });
    writeFileSync(settingsFile, originalSettings);
  }
});
