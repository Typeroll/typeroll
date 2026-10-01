import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const site = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default');
const main = path.join(site, 'versions/main');
const written = [
  path.join(main, 'pages/reuse-a.json'),
  path.join(main, 'pages/reuse-b.json'),
  path.join(main, 'partials/call-to-action.json'),
  path.join(site, 'block_templates/intro-starter.json'),
];

test('global blocks stay shared and block templates are copied', async ({ page }, info) => {
  mkdirSync(path.join(main, 'pages'), { recursive: true });
  writeFileSync(written[0], JSON.stringify({
    id: 'reuse-a', title: 'Reuse A', slug: 'reuse-a', status: 'draft', content_mode: 'blocks',
    blocks: [
      { id: 'intro', name: 'Intro text', type: 'core/prose', data: { html: '<p>Starter intro.</p>' } },
      { id: 'cta', name: 'CTA section', type: 'core/section', data: {}, children: [{ id: 'cta-h', type: 'core/heading', data: { text: 'Book a call', level: 'h2' } }] },
    ],
  }));
  writeFileSync(written[1], JSON.stringify({
    id: 'reuse-b', title: 'Reuse B', slug: 'reuse-b', status: 'draft', content_mode: 'blocks',
    blocks: [{ id: 'b-intro', name: 'Page B text', type: 'core/prose', data: { html: '<p>Page B.</p>' } }],
  }));
  page.on('dialog', dialog => void dialog.accept());
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/app/sites/default/pages/reuse-a', { waitUntil: 'networkidle' });
    const preview = page.frameLocator('iframe[title="Preview"]');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();

    // A section becomes a global block; the page keeps showing it.
    await page.getByRole('button', { name: 'Edit CTA section', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Make global block…' }).click();
    await page.getByLabel('Global block name').fill('Call to action');
    await page.getByRole('button', { name: 'Make global block', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Call to action', exact: true })).toBeVisible();
    await expect(preview.getByRole('heading', { name: 'Book a call' })).toBeVisible();

    // Another block becomes a template.
    await page.getByRole('button', { name: 'Edit Intro text', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Save as template…' }).click();
    await page.getByLabel('Template name').fill('Intro starter');
    await page.getByLabel('When to use it').fill('Opening paragraph');
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved as a template' })).toBeVisible();

    // Page B adds both from the block library.
    await page.goto('/app/sites/default/pages/reuse-b', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Call to action/ }).click();
    await expect(preview.getByRole('heading', { name: 'Book a call' })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Intro starter/ }).click();
    await expect(preview.getByText('Starter intro.')).toBeVisible();
    await page.screenshot({ path: info.outputPath('library-1440.png') });

    // Editing the global block changes every page using it.
    await page.goto('/app/sites/default/partials', { waitUntil: 'networkidle' });
    await expect(page.getByText('used on 2 pages')).toBeVisible();
    await expect(page.getByText('Intro starter')).toBeVisible();
    await page.screenshot({ path: info.outputPath('global-blocks-1440.png'), fullPage: true });
    await page.getByRole('link', { name: /Call to action/ }).click();
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Book a call', exact: true }).click();
    await page.getByLabel('Heading text').fill('Book a meeting');
    await page.getByLabel('Heading text').press('Tab');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText('Reuse A')).toBeVisible();

    await page.goto('/app/sites/default/pages/reuse-b', { waitUntil: 'networkidle' });
    await expect(preview.getByRole('heading', { name: 'Book a meeting' })).toBeVisible();

    // Detaching leaves an independent copy.
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Call to action', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Detach (edit on this page only)' }).click();
    await expect(page.getByRole('button', { name: 'Edit Call to action', exact: true })).toHaveCount(0);
    await expect(preview.getByRole('heading', { name: 'Book a meeting' })).toBeVisible();
  } finally {
    for (const file of written) rmSync(file, { force: true });
  }
});
