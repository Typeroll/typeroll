import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';
import { gotoReady } from './helpers/ready';

const fixtures = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations');
const main = path.join(fixtures, 'default/sites/default/versions/main');
const coreMain = path.join(fixtures, 'e2e-core/sites/e2e-core-site/versions/main');
const settingsFile = path.join(main, 'settings/default.json');

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** No horizontal page scroll at the current width. */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('an admin builds the icon list from its starter and fills it in on a page', async ({ page }, info) => {
  const written = [path.join(main, 'pages/block-types-a.json'), path.join(main, 'pages/contact-us.json'), path.join(main, 'block_types/icon_list.json')];
  const originalSettings = readFileSync(settingsFile, 'utf8');
  // Version 4 renders an icon inside a linked card without a nested link.
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(originalSettings), render_version: 4 }));
  writeJson(written[0]!, { id: 'block-types-a', title: 'Why us', slug: 'why-us', status: 'draft', content_mode: 'blocks', blocks: [
    { id: 'intro', name: 'Intro', type: 'core/heading', data: { text: 'Why choose us', level: 'h2' } },
  ] });
  writeJson(written[1]!, { id: 'contact-us', title: 'Contact us', slug: 'contact-us', status: 'published', content_mode: 'blocks', blocks: [] });
  page.on('dialog', dialog => void dialog.accept());
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, '/app/sites/default/blocks');
    await page.getByRole('button', { name: 'New block type' }).first().click();
    await page.getByRole('button', { name: /^Icon list/ }).click();
    await expect(page.getByRole('heading', { name: 'Icon list', level: 2 })).toBeVisible();

    // Fields: rename the item heading's label.
    await page.getByRole('tab', { name: 'Fields' }).click();
    await page.locator('.bb-fieldcard__toggle', { hasText: /^Items/ }).click();
    await page.locator('.bb-fieldcard__toggle', { hasText: /^Heading/ }).click();
    const headingCard = page.locator('.bb-fieldcard').filter({ has: page.locator('.bb-fieldcard__toggle', { hasText: /^Heading/ }) }).last();
    await headingCard.getByLabel('Label', { exact: true }).fill('Title');
    await expect(page.locator('.bb-fieldcard__toggle', { hasText: /^Title/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('builder-fields-1440.png'), fullPage: true });

    // The preview renders the unsaved definition.
    await page.getByRole('tab', { name: 'Preview' }).click();
    const builderPreview = page.frameLocator('iframe[title="Block type preview"]');
    await expect(builderPreview.locator('[data-block="icon_list"] h3').first()).toHaveText('Title 1');
    await page.getByRole('button', { name: 'Tablet', exact: false }).click();
    await expect(builderPreview.locator('[data-block="icon_list"] h3').first()).toBeVisible();
    await page.waitForTimeout(500); // the frame resizes to its content after load
    await page.screenshot({ path: info.outputPath('builder-preview-1440.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Blocks' }).click();
    await page.getByRole('tab', { name: 'Structure' }).click();
    // The structure tree labels a bound heading by its binding.
    await page.getByRole('button', { name: 'Edit {{item.title}}', exact: true }).click();
    await expect(page.getByText('Filled from')).toBeVisible();
    await page.screenshot({ path: info.outputPath('builder-blocks-1440.png'), fullPage: true });

    await page.getByRole('button', { name: 'Create block type' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Created' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Icon list/ })).toHaveAttribute('aria-current', 'page');
    const stored = JSON.parse(readFileSync(written[2]!, 'utf8'));
    expect(stored.schema[0].fields.find((field: { name: string }) => field.name === 'title').label).toBe('Title');
    expect(stored.composition[0].type).toBe('core/repeater');

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page, '/app/sites/default/blocks?type=icon_list');
    await page.getByRole('tab', { name: 'Fields' }).click();
    await page.locator('.bb-fieldcard__toggle', { hasText: /^Items/ }).click();
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath('builder-390.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.frameLocator('iframe[title="Block type preview"]').locator('[data-block="icon_list"]')).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath('builder-preview-390.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Place it on a page and fill in two items.
    await gotoReady(page, '/app/sites/default/pages/block-types-a');
    const preview = page.frameLocator('iframe[title="Preview"]');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Icon list', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Icon list', level: 3 })).toBeVisible();
    await expect(page.getByText('At least 1 item')).toBeVisible();

    await page.getByRole('button', { name: 'Add item' }).click();
    const first = page.locator('.array-input__item').nth(0);
    await first.getByLabel('Title', { exact: true }).fill('Fast delivery');
    await first.getByLabel('Text', { exact: true }).fill('Within two days');
    await first.getByRole('button', { name: 'Choose icon for Icon' }).click();
    await first.getByRole('searchbox', { name: 'Search icons for Icon' }).fill('truck');
    await first.getByRole('button', { name: 'truck', exact: true }).click();
    await first.getByRole('searchbox', { name: 'Search pages to link Link to' }).fill('Contact');
    await first.getByRole('button', { name: /Contact us/ }).click();
    await expect(first.getByText('Contact us', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add item' }).click();
    const second = page.locator('.array-input__item').nth(1);
    await second.getByLabel('Title', { exact: true }).fill('Free returns');
    await second.getByLabel('Text', { exact: true }).fill('Within 30 days');

    // Reorder with the keyboard-accessible button.
    await page.getByRole('button', { name: 'Move Free returns up' }).click();
    await expect(page.locator('.array-input__toggle').first()).toHaveText('Free returns');
    await expect(page.getByRole('button', { name: 'Move Free returns up' })).toBeDisabled();

    const list = preview.locator('[data-block="icon_list"]');
    await expect(list.locator('h3')).toHaveText(['Free returns', 'Fast delivery'], { timeout: 15_000 });
    await expect(list.getByRole('link', { name: /Fast delivery/ })).toHaveAttribute('href', /contact-us/);
    await expect(list.getByRole('link', { name: /Free returns/ })).toHaveCount(0);
    await expect(list.locator('svg').first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: info.outputPath('page-inspector-1440.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Edit block' }).click();
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath('page-inspector-390.png'), fullPage: true });
  } finally {
    for (const file of written) rmSync(file, { force: true });
    writeFileSync(settingsFile, originalSettings);
  }
});

test('an admin turns a section on a page into a block type and the page keeps its text', async ({ page }, info) => {
  const pageFile = path.join(main, 'pages/turn-into.json');
  const typeFile = path.join(main, 'block_types/offer_banner.json');
  writeJson(pageFile, { id: 'turn-into', title: 'Offers', slug: 'offers', status: 'draft', content_mode: 'blocks', blocks: [
    { id: 'offer', name: 'Offer section', type: 'core/section', data: {}, children: [
      { id: 'offer-h', type: 'core/heading', data: { text: 'Spring offer', level: 'h2' } },
      { id: 'offer-p', type: 'core/prose', data: { html: '<p>Half price on all plans.</p>' } },
      { id: 'offer-b', type: 'core/button', data: { label: 'See plans', href: '/pricing' } },
    ] },
  ] });
  page.on('dialog', dialog => void dialog.accept());
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, '/app/sites/default/pages/turn-into');
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole('heading', { name: 'Spring offer' })).toBeVisible();
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Offer section', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Turn into block type…' }).click();
    const form = page.getByRole('form', { name: 'Turn into block type' });
    await form.getByLabel('Block type name').fill('Offer banner');
    await expect(form.getByLabel('Name used by the API and agents')).toHaveValue('offer_banner');
    // The button's address stays fixed; its text and the heading and text become fields.
    await form.getByRole('checkbox', { name: /Button · Link to/ }).uncheck();
    await page.screenshot({ path: info.outputPath('turn-into-1440.png') });
    await form.getByRole('button', { name: 'Create block type' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Created the block type “Offer banner”' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Offer banner', level: 3 })).toBeVisible();
    await expect(page.getByText(/Built from 4 blocks/)).toBeVisible();
    const banner = preview.locator('[data-block="offer_banner"]');
    await expect(banner.getByRole('heading', { name: 'Spring offer' })).toBeVisible({ timeout: 15_000 });
    await expect(banner.getByText('Half price on all plans.')).toBeVisible();
    await expect(banner.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', /pricing/);

    const stored = JSON.parse(readFileSync(typeFile, 'utf8'));
    expect(stored.composition[0].children[0].data.text).toBe('{{props.heading}}');
    expect(stored.composition[0].children[2].data.href).toBe('/pricing');

    // Its fields edit the instance like any other block.
    await page.getByLabel('Heading', { exact: true }).fill('Summer offer');
    await expect(banner.getByRole('heading', { name: 'Summer offer' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: info.outputPath('turned-into-1440.png') });

    await gotoReady(page, '/app/sites/default/pages/turn-into');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Offer section', exact: true })).toBeVisible();
    await expect(preview.locator('[data-block="offer_banner"]').getByText('Half price on all plans.')).toBeVisible();

    // Detach puts the blocks back on the page with the instance's values.
    await page.getByRole('button', { name: 'Edit Offer section', exact: true }).click();
    await page.getByText('Reuse', { exact: true }).click();
    await page.getByRole('button', { name: 'Detach into blocks' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Detached' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Summer offer', exact: true })).toBeVisible();
    await expect(preview.getByRole('heading', { name: 'Summer offer' })).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator('[data-block="offer_banner"]')).toHaveCount(0);
  } finally {
    rmSync(pageFile, { force: true });
    rmSync(typeFile, { force: true });
  }
});

test('an editor cannot open the builder but fills in a placed composed block', async ({ page }, info) => {
  const typeFile = path.join(coreMain, 'block_types/team_note.json');
  const pageFile = path.join(coreMain, 'pages/editor-composed.json');
  writeJson(typeFile, {
    id: 'team_note', name: 'team_note', label: 'Team note', category: 'content', container: false, origin: 'user', created_at: '2026-10-01T00:00:00.000Z', css_scope: 'block',
    description: 'A short notice from the team.',
    schema: [{ name: 'note', type: 'text', label: 'Note text', help: 'One sentence.' }],
    composition: [{ id: 'n', type: 'core/text', data: { text: '{{props.note}}' } }],
  });
  writeJson(pageFile, { id: 'editor-composed', title: 'Notices', slug: 'notices', status: 'draft', content_mode: 'blocks', blocks: [
    { id: 'note1', name: 'Team note', type: 'team_note', data: { note: 'Office closed on Friday' } },
  ] });
  try {
    await authenticatePersona(page, 'editor');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, '/app/sites/e2e-core-site/blocks');
    await expect(page.getByText('Only Site admins can create and change block types.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New block type' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('editor-builder-denied-1440.png') });
    const origin = process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322';
    const refused = await page.request.post('/api/sites/e2e-core-site/blocks/types', {
      headers: { Origin: origin },
      data: { name: 'sneaky', label: 'Sneaky', schema: [], template: '<p>x</p>' },
    });
    expect(refused.status()).toBe(403);

    await gotoReady(page, '/app/sites/e2e-core-site/pages/editor-composed');
    const preview = page.frameLocator('iframe[title="Preview"]');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Team note', exact: true }).click();
    await expect(page.getByText(/Built from 1 block\./)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit the block type' })).toHaveCount(0);
    await expect(page.getByText('One sentence.')).toBeVisible();
    await page.getByText('Reuse', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn into block type…' })).toHaveCount(0);
    await page.getByLabel('Note text', { exact: true }).fill('Office open on Friday');
    await expect(preview.locator('[data-block="team_note"]')).toHaveText('Office open on Friday', { timeout: 15_000 });
    await page.screenshot({ path: info.outputPath('editor-props-1440.png') });
  } finally {
    rmSync(typeFile, { force: true });
    rmSync(pageFile, { force: true });
  }
});
