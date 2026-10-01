import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady } from './helpers/ready';

test('style library: add standard styles, edit one, refuse low contrast, and apply it to a heading', async ({ page }, info) => {
  const file = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/pages/styled-heading.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: 'styled-heading', title: 'Styled', slug: 'styled-heading', status: 'draft', content_mode: 'blocks', blocks: [{ id: 'kicker', type: 'core/heading', data: { text: 'For leadership teams', level: 'h2' } }] }));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, '/app/sites/default/styles');
    await page.getByRole('button', { name: 'Add standard styles' }).click();
    await expect(page.getByRole('status')).toContainText(/Added \d+ standard styles|already here/);

    await page.getByRole('button', { name: /^Eyebrow/ }).click();
    await page.getByLabel('Size', { exact: true }).fill('0.875rem');
    const preview = page.frameLocator('iframe[title="Style preview"]').locator('.s-eyebrow');
    await expect(preview).toHaveCSS('font-size', '14px');
    await expect(preview).toHaveCSS('text-transform', 'uppercase');

    // Light grey on white is refused before it can be saved.
    const colour = page.getByLabel('Text colour', { exact: true });
    await colour.selectOption('custom');
    await page.getByLabel('Text colour value').fill('#cccccc');
    await expect(page.getByRole('alert')).toContainText('contrast');
    await expect(page.getByRole('button', { name: 'Save style' })).toBeDisabled();
    await page.getByLabel('Text colour value').fill('#1d4ed8');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save style' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await page.screenshot({ path: info.outputPath('styles-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 900 });
    // One column on phones: the editor is as wide as the page, not squeezed beside the list.
    const editorWidth = await page.getByLabel('Name', { exact: true }).evaluate(el => el.getBoundingClientRect().width);
    expect(editorWidth).toBeGreaterThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('styles-390.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await gotoReady(page, '/app/sites/default/pages/styled-heading');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit For leadership teams', exact: true }).click();
    await page.getByLabel('Heading style', { exact: true }).selectOption({ label: 'Eyebrow' });
    const heading = page.frameLocator('iframe[title="Preview"]').getByRole('heading', { name: 'For leadership teams' });
    await expect(heading).toHaveCSS('text-transform', 'uppercase');
    await expect(heading).toHaveCSS('font-size', '14px');
    await expect(heading).toHaveCSS('color', 'rgb(29, 78, 216)');
    await page.screenshot({ path: info.outputPath('editor-style-1440.png') });
  } finally { rmSync(file, { force: true }); }
});
