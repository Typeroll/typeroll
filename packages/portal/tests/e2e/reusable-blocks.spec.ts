import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady, reloadReady, waitForHydration } from './helpers/ready';

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
    await gotoReady(page, '/app/sites/default/pages/reuse-a');
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
    await gotoReady(page, '/app/sites/default/pages/reuse-b');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Call to action/ }).click();
    await expect(preview.getByRole('heading', { name: 'Book a call' })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Intro starter/ }).click();
    await expect(preview.getByText('Starter intro.')).toBeVisible();
    await page.screenshot({ path: info.outputPath('library-1440.png') });

    // Editing the global block changes every page using it.
    await gotoReady(page, '/app/sites/default/partials');
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

    await gotoReady(page, '/app/sites/default/pages/reuse-b');
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

test('usage covers templates and nesting blocks; a block header edits like a global block; detach copies the draft', async ({ page }, info) => {
  const header = path.join(main, 'partials/header.json');
  const originalHeader = readFileSync(header);
  const headerDraft = path.join(main, 'working_copies/partial--header.json');
  const promoDraft = path.join(main, 'working_copies/partial--promo-strip.json');
  const files = [
    path.join(main, 'partials/promo-strip.json'),
    path.join(main, 'partials/banner-wrap.json'),
    path.join(main, 'page_templates/promo-landing.json'),
    path.join(main, 'pages/promo-page.json'),
    headerDraft,
    promoDraft,
  ];
  const ref = (id: string) => ({ id, type: 'core/global_block', data: { global_block_id: 'promo-strip' } });
  const heading = (id: string, text: string) => ({ id, type: 'core/heading', data: { text, level: 'h2' } });
  const draft = (target: string, blocks: unknown[]) => JSON.stringify({ kind: 'partial', target_id: target, fields: { blocks }, updated_at: new Date().toISOString() });
  for (const dir of ['partials', 'page_templates', 'pages', 'working_copies']) mkdirSync(path.join(main, dir), { recursive: true });
  writeFileSync(files[0], JSON.stringify({ name: 'Promo strip', kind: 'free', content_mode: 'blocks', status: 'published', blocks: [heading('promo-h', 'Limited offer')] }));
  writeFileSync(files[1], JSON.stringify({ name: 'Banner wrap', kind: 'free', content_mode: 'blocks', status: 'published', blocks: [ref('nested-ref')] }));
  writeFileSync(files[2], JSON.stringify({ name: 'promo-landing', label: 'Promo landing', status: 'published', created_at: '2026-01-01T00:00:00Z', blocks: [ref('tpl-ref'), { id: 'slot', type: 'template_content_slot', data: {} }] }));
  writeFileSync(files[3], JSON.stringify({ id: 'promo-page', title: 'Promo page', slug: 'promo-page', status: 'draft', content_mode: 'blocks', blocks: [{ ...ref('page-ref'), name: 'Promo strip' }] }));
  writeFileSync(header, JSON.stringify({ name: 'Main header', kind: 'header', content_mode: 'blocks', status: 'published', blocks: [heading('hdr-h', 'Header title'), ref('hdr-ref')] }));
  writeFileSync(headerDraft, draft('header', [heading('hdr-draft', 'Header from agent draft')]));
  page.on('dialog', dialog => void dialog.accept());
  const draftBanner = page.getByRole('alert').filter({ hasText: 'This header has a draft' });
  /** The draft buttons reload the page; wait for the new document to hydrate. */
  const afterReload = async (action: () => Promise<void>) => {
    const reloaded = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
    await action();
    await reloaded;
    await waitForHydration(page);
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });

    // The list and the editor count templates and global blocks, including the header.
    await gotoReady(page, '/app/sites/default/partials');
    await expect(page.getByText('used on 1 page, 1 template and 2 global blocks')).toBeVisible();
    await gotoReady(page, '/app/sites/default/partials/promo-strip');
    const usage = page.getByTestId('global-block-usage');
    await expect(usage.getByText('Used on 1 page, 1 template and 2 global blocks.')).toBeVisible();
    for (const name of ['Promo page', 'Promo landing', 'Banner wrap', 'Main header']) {
      await expect(usage.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(usage.getByText('· header, every page')).toBeVisible();
    await page.screenshot({ path: info.outputPath('global-block-usage-1440.png') });

    // A block-mode header opens in the block editor and shows its pending draft.
    await gotoReady(page, '/app/sites/default/partials/header');
    await expect(draftBanner).toBeVisible();
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Header from agent draft', exact: true })).toBeVisible();
    await expect(page.getByText('Shown on every page')).toBeVisible();
    await page.screenshot({ path: info.outputPath('header-draft-1440.png') });

    // Discarding keeps the saved header, which can then be edited directly.
    await afterReload(() => page.getByRole('button', { name: 'Discard draft', exact: true }).click());
    await expect(draftBanner).toHaveCount(0);
    expect(existsSync(headerDraft)).toBe(false);
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Header title', exact: true }).click();
    await page.getByLabel('Heading text').fill('Header edited');
    await page.getByLabel('Heading text').press('Tab');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect.poll(() => JSON.parse(readFileSync(header, 'utf8')).blocks[0].data.text).toBe('Header edited');
    await page.screenshot({ path: info.outputPath('header-blocks-1440.png') });

    // Saving a draft makes it the header.
    writeFileSync(headerDraft, draft('header', [heading('hdr-agent', 'Header saved from draft')]));
    await reloadReady(page);
    await expect(draftBanner).toBeVisible();
    await afterReload(() => page.getByRole('button', { name: 'Save draft', exact: true }).click());
    await expect(draftBanner).toHaveCount(0);
    expect(JSON.parse(readFileSync(header, 'utf8')).blocks[0].data.text).toBe('Header saved from draft');

    // Detaching copies the global block's draft, which the editor preview shows.
    writeFileSync(promoDraft, draft('promo-strip', [heading('promo-draft', 'Draft offer')]));
    await gotoReady(page, '/app/sites/default/pages/promo-page');
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole('heading', { name: 'Draft offer' })).toBeVisible();
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Promo strip', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Detach (edit on this page only)' }).click();
    await expect(page.getByRole('button', { name: 'Edit Draft offer', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Promo strip', exact: true })).toHaveCount(0);
    // The copy stays once the global block's draft is gone.
    rmSync(promoDraft, { force: true });
    await reloadReady(page);
    await expect(preview.getByRole('heading', { name: 'Draft offer' })).toBeVisible();
  } finally {
    writeFileSync(header, originalHeader);
    for (const file of files) rmSync(file, { force: true });
  }
});
