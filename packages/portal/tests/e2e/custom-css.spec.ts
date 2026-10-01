import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main');
const pageFile = path.join(root, 'pages/css-page.json');
const settingsFile = path.join(root, 'settings/default.json');

test('site and page CSS are checked, saved and applied', async ({ page }, info) => {
  const originalSettings = readFileSync(settingsFile, 'utf8');
  mkdirSync(path.dirname(pageFile), { recursive: true });
  writeFileSync(pageFile, JSON.stringify({
    id: 'css-page', title: 'CSS page', slug: 'css-page', status: 'draft', content_mode: 'blocks',
    blocks: [{ id: 'note', name: 'Note', type: 'core/heading', data: { text: 'Pricing note', level: 'h2' }, style_overrides: { custom_class: 'pricing-note' } }],
  }));
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/app/sites/default/styles', { waitUntil: 'networkidle' });
    const siteCss = page.getByLabel('CSS for every page');
    await siteCss.fill('.pricing-note { color: #b91c1c;\n');
    await expect(page.getByRole('alert').filter({ hasText: 'is not closed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save CSS' })).toBeDisabled();
    await siteCss.fill('[data-block="heading"] { letter-spacing: 0.02em }\n.pricing-note { color: rgb(185, 28, 28) }');
    await expect(page.getByText(/targets platform markup/)).toBeVisible();
    await page.getByRole('button', { name: 'Save CSS' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).custom_css).toContain('.pricing-note');
    await page.screenshot({ path: info.outputPath('site-css-1280.png'), fullPage: true });

    await page.goto('/app/sites/default/pages/css-page', { waitUntil: 'networkidle' });
    const preview = page.frameLocator('iframe[title="Preview"]');
    const heading = preview.getByRole('heading', { name: 'Pricing note' });
    await expect(heading).toHaveCSS('color', 'rgb(185, 28, 28)');
    await page.getByText('Page CSS', { exact: true }).click();
    await expect(page.getByRole('button', { name: '.pricing-note' })).toBeVisible();
    await page.getByLabel('CSS for this page only').fill('.pricing-note { text-transform: uppercase }');
    await expect(heading).toHaveCSS('text-transform', 'uppercase', { timeout: 10_000 });
  } finally {
    rmSync(pageFile, { force: true });
    writeFileSync(settingsFile, originalSettings);
  }
});
