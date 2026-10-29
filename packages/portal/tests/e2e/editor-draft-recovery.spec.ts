import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady, reloadReady, waitForHydration } from './helpers/ready';

const version = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main');
test.beforeEach(async ({ page }) => { page.on('dialog', dialog => dialog.accept()); });

const blocks = [
  { id: 'heading', type: 'core/heading', data: { text: 'Saved heading', level: 'h2' } },
  { id: 'image', name: 'Test image', type: 'core/image', data: { src: '/favicon.ico', alt: 'Test image' } },
];

for (const mode of ['blocks', 'html']) {
  test(`${mode}: Back preserves the saved page and asks before recovering autosave`, async ({ page }, testInfo) => {
    const id = `recovery-${mode}-${testInfo.project.name}`;
    const file = path.join(version, `pages/${id}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ id, title: 'Saved page', slug: id, path: `/${id}/`, status: 'draft', content_mode: mode, blocks, html_content: '<p>Saved body</p>' }));
    const wc = `/api/sites/default/working-copy/page/${id}`;
    try {
      await gotoReady(page, '/app/sites/default/pages');
      await gotoReady(page, `/app/sites/default/pages/${id}`);
      if (mode === 'blocks') {
        await page.getByRole('button', { name: 'Structure', exact: true }).click();
        await page.locator('.block-editor__tree-row').filter({ hasText: 'Test image' }).getByTitle('Delete', { exact: true }).click();
        await expect(page.locator('.block-editor__tree-row').filter({ hasText: 'Test image' })).toHaveCount(0);
      } else {
        await page.getByLabel('Page title', { exact: true }).fill('Autosaved title');
      }
      await expect.poll(async () => (await (await page.request.get(wc)).json()).working_copy).toBeTruthy();
      expect(JSON.parse(readFileSync(file, 'utf8')).title).toBe('Saved page');
      expect(JSON.parse(readFileSync(file, 'utf8')).blocks).toHaveLength(2);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.goForward({ waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await expect(page.getByRole('heading', { name: 'Continue your autosaved draft?' })).toBeVisible();
      await expect(page.locator('iframe')).toHaveCount(0);
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      await page.screenshot({ path: testInfo.outputPath('recovery-mobile.png') });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: testInfo.outputPath('recovery-desktop.png') });
      await page.getByRole('button', { name: 'Continue autosaved draft', exact: true }).click();
      if (mode === 'blocks') {
        await page.getByRole('button', { name: 'Structure', exact: true }).click();
        await expect(page.locator('.block-editor__tree-row').filter({ hasText: 'Test image' })).toHaveCount(0);
      } else await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Autosaved title');
      await reloadReady(page);
      // A failed discard must keep the choice open and the recovery data intact.
      await page.route(`**/working-copy/page/${id}`, async route => {
        if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, body: '{}' });
        else await route.continue();
      });
      await page.getByRole('button', { name: 'Discard draft and open saved version' }).click();
      await expect(page.getByRole('alert')).toContainText('Could not discard');
      await expect(page.locator('iframe')).toHaveCount(0);
      await page.unroute(`**/working-copy/page/${id}`);
      await page.getByRole('button', { name: 'Discard draft and open saved version' }).click();
      await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Saved page');
      if (mode === 'blocks') {
        await page.getByRole('button', { name: 'Structure', exact: true }).click();
        await expect(page.locator('.block-editor__tree-row').filter({ hasText: 'Test image' })).toHaveCount(1);
      }
      expect((await (await page.request.get(wc)).json()).working_copy).toBeNull();
      await reloadReady(page);
      await expect(page.getByRole('heading', { name: 'Continue your autosaved draft?' })).toHaveCount(0);
      // A deliberate save, unlike autosave or Back, updates the canonical page.
      await page.getByLabel('Page title', { exact: true }).fill('Explicitly saved');
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).title).toBe('Explicitly saved');
      await reloadReady(page);
      await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Explicitly saved');
      await expect(page.getByRole('heading', { name: 'Continue your autosaved draft?' })).toHaveCount(0);
    } finally { await page.request.delete(wc, { headers: { Origin: 'http://127.0.0.1:4322' } }); rmSync(file, { force: true }); }
  });
}

test('block history works in the canvas, waits for autosave, and recovers from write failure', async ({ page }, testInfo) => {
  const id = `history-${testInfo.project.name}`;
  const file = path.join(version, `pages/${id}.json`);
  writeFileSync(file, JSON.stringify({ id, title: 'History test', slug: id, path: `/${id}/`, status: 'draft', content_mode: 'blocks', blocks }));
  const wc = `/api/sites/default/working-copy/page/${id}`;
  try {
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    const imageRow = page.locator('.block-editor__tree-row').filter({ hasText: 'Test image' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/pages/${id}/blocks?**`, async route => {
      if (route.request().method() === 'DELETE') await held;
      await route.continue();
    });
    await imageRow.getByTitle('Delete', { exact: true }).click();
    // Trigger while DELETE is in flight: history must wait, not swallow Cmd-Z.
    await page.keyboard.press('Meta+z');
    release();
    await expect(page.getByTitle('Redo (⇧⌘Z)', { exact: true })).toBeEnabled();
    await expect(imageRow).toHaveCount(1);
    const canvas = page.frameLocator('iframe[title="Preview"]');
    await canvas.getByRole('heading', { name: 'Saved heading' }).click();
    await page.keyboard.press('Meta+Shift+z');
    await expect(imageRow).toHaveCount(0);
    await canvas.getByRole('heading', { name: 'Saved heading' }).click();
    await page.keyboard.press('Control+z');
    await expect(imageRow).toHaveCount(1);
    await page.route(`**/working-copy/page/${id}`, async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Test write failure"}' });
      else await route.continue();
    });
    await page.getByTitle('Redo (⇧⌘Z)', { exact: true }).click();
    await expect(page.locator('.block-editor__status')).toContainText('Test write failure');
    await expect(imageRow).toHaveCount(1);
    await expect(page.getByTitle('Redo (⇧⌘Z)', { exact: true })).toBeEnabled();
    await page.unroute(`**/working-copy/page/${id}`);
    await page.getByTitle('Redo (⇧⌘Z)', { exact: true }).click();
    await expect(imageRow).toHaveCount(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).blocks).toHaveLength(2);
    // Native text undo must not remove/restore whole blocks.
    await page.getByRole('button', { name: 'Page settings', exact: true }).click();
    const title = page.getByLabel('Page title', { exact: true });
    await title.focus();
    await page.keyboard.press('End');
    await page.keyboard.type(' changed');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(imageRow).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('history-desktop.png') });
  } finally { await page.request.delete(wc, { headers: { Origin: 'http://127.0.0.1:4322' } }); rmSync(file, { force: true }); }
});

test('structure labels decode entities and visual HTML never receives an empty placeholder', async ({ page }, testInfo) => {
  const id = `visual-content-${testInfo.project.name}`;
  const file = path.join(version, `pages/${id}.json`);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="60" fill="teal"/></svg>';
  await page.route('**/editor-background.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: svg }));
  writeFileSync(file, JSON.stringify({ id, title: 'Visible content', slug: id, path: `/${id}/`, status: 'draft', content_mode: 'blocks',
    custom_css: '@media(max-width:600px){.responsive-background{background-image:none!important}}',
    blocks: [
      { id: 'swedish', type: 'core/prose', data: { html: '<p>V&#xe4;lkommen till &Aring;ngermanland &amp; &#246;arna</p>' } },
      { id: 'portrait', type: 'core/html', data: { html: '<div style="background-image:url(/editor-background.svg);width:120px;height:120px;border-radius:50%"></div>' } },
      { id: 'picture', type: 'core/html', data: { html: '<img src="/editor-background.svg" width="120" height="120" alt="" />' } },
      { id: 'responsive', type: 'core/html', data: { html: '<div class="responsive-background" style="background-image:url(/editor-background.svg);width:120px;height:120px"></div>' } },
      { id: 'empty', type: 'core/html', data: { html: '<div></div>' } },
    ] }));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Välkommen till Ångermanland & öarna', exact: true })).toBeVisible();
    const canvas = page.frameLocator('iframe[title="Preview"]');
    await expect(canvas.locator('[data-block-id="empty"]')).toHaveAttribute('data-empty-label', 'HTML');
    for (const block of ['portrait', 'picture', 'responsive']) {
      await expect(canvas.locator(`[data-block-id="${block}"]`)).not.toHaveAttribute('data-empty-label');
    }
    await page.screenshot({ path: testInfo.outputPath('visual-content-desktop.png') });
    await page.getByRole('button', { name: 'Phone — mobile starts at 0px', exact: true }).click();
    await expect(canvas.locator('[data-block-id="responsive"]')).toHaveAttribute('data-empty-label', 'HTML');
    await expect(canvas.locator('[data-block-id="portrait"]')).not.toHaveAttribute('data-empty-label');
    await page.screenshot({ path: testInfo.outputPath('visual-content-mobile.png') });
    // Go wide again: a label added at a narrower width must be removed.
    await page.getByRole('button', { name: 'Desktop — wide starts at 1536px', exact: true }).click();
    await expect(canvas.locator('[data-block-id="responsive"]')).not.toHaveAttribute('data-empty-label');
  } finally { rmSync(file, { force: true }); }
});
