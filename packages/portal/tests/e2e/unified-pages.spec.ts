import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const version = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main');
for (const width of [390, 1440]) test(`one Page list and editor support content type changes at ${width}px`, async ({ page }, testInfo) => {
  const id = `unified-page-${width}`;
  const typeId = `unified-article-${width}`;
  const file = path.join(version, `pages/${id}.json`);
  const typeFile = path.join(version, `content_types/${typeId}.json`);
  mkdirSync(path.dirname(typeFile), { recursive: true });
  writeFileSync(typeFile, JSON.stringify({ id: typeId, name: typeId, label_singular: 'Test article', label_plural: 'Test articles', fields: [{ name: 'summary', label: 'Article summary', type: 'text', required: true }], route_template: '/articles/{slug}' }));
  writeFileSync(file, JSON.stringify({ id, title: 'Unified test article', slug: id, content_type: typeId, fields: { summary: 'Original summary' }, status: 'draft', content_mode: 'blocks', blocks: [{ id: 'heading', type: 'core/heading', data: { text: 'Preserved body', level: 'h1' } }] }));
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/sites/default/pages', { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: 'Unified test article', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Collections', exact: true })).toHaveCount(0);
    await page.getByLabel('Filter by content type').selectOption(typeId);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`pages-${width}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Unified test article', exact: true }).click();
    await page.waitForLoadState('networkidle');
    if (width < 800) await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Content type', { exact: true })).toHaveValue(typeId);
    await page.getByLabel('Content type', { exact: true }).selectOption('page');
    await expect(page.getByRole('button', { name: 'Save content type', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save content type', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`content-type-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Save content type', exact: true }).click();
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).content_type).toBe('page');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.path).toBe(`/articles/${id}`);
    expect(saved.blocks[0].data.text).toBe('Preserved body');
    expect(saved.status).toBe('draft');
    expect(saved.fields ?? {}).not.toHaveProperty('summary');
    await page.reload({ waitUntil: 'networkidle' });
    if (width < 800) await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Content type', { exact: true })).toHaveValue('page');
    await page.getByLabel('Content type', { exact: true }).selectOption(typeId);
    await page.getByRole('button', { name: 'Save content type', exact: true }).click();
    await expect(page.locator('.page-type-picker [role="alert"]')).toBeVisible();
    expect(JSON.parse(readFileSync(file, 'utf8')).content_type).toBe('page');
    await page.locator('.page-type-picker').getByLabel('Article summary').fill('A newly required summary');
    await page.getByRole('button', { name: 'Save content type', exact: true }).click();
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).content_type).toBe(typeId);
    expect(JSON.parse(readFileSync(file, 'utf8')).fields.summary).toBe('A newly required summary');
  } finally {
    rmSync(file, { force: true }); rmSync(typeFile, { force: true });
    rmSync(path.join(version, `pages/${id}`), { recursive: true, force: true });
  }
});

for (const width of [390, 1440]) test(`Page template choices and manual order save together at ${width}px`, async ({ page }, testInfo) => {
  const typeId = `options-${width}`, id = `options-page-${width}`;
  const file = path.join(version, `pages/${id}.json`), typeFile = path.join(version, `content_types/${typeId}.json`);
  const templateIds = [`standard-${width}`, `wide-${width}`, `outside-${width}`];
  mkdirSync(path.dirname(typeFile), { recursive: true });
  mkdirSync(path.join(version, 'page_templates'), { recursive: true });
  for (const templateId of templateIds) writeFileSync(path.join(version, `page_templates/${templateId}.json`), JSON.stringify({ id: templateId, name: templateId, label: templateId, status: 'published', applies_to: 'any', blocks: [{ id: 'label', type: 'core/heading', data: { text: templateId, level: 'h2' } }, { id: 'body', type: 'template_content_slot', data: {} }] }));
  writeFileSync(typeFile, JSON.stringify({ id: typeId, name: typeId, label_singular: 'Example', label_plural: 'Examples', fields: [], route_template: '/examples/{slug}', template: templateIds[0], sort_field: 'date_published', sort_dir: 'desc' }));
  writeFileSync(file, JSON.stringify({ id, title: 'Template example', slug: id, content_type: typeId, status: 'draft', sort_order: 10, content_mode: 'blocks', blocks: [{ id: 'text', type: 'core/prose', data: { html: '<p>Same editable body</p>' } }] }));
  const metadata = async () => { if (width < 800) await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('button', { name: 'Settings', exact: true }).click(); };
  const save = async () => {
    await page.locator('.pmenu__trigger').click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  };
  try {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/app/sites/default/content-types/${typeId}`, { waitUntil: 'networkidle' });
    await page.getByLabel('Default sort field').selectOption('sort_order');
    await page.getByLabel('Default sort direction').selectOption('asc');
    await page.getByLabel('Limit the templates editors can choose').check();
    await page.getByRole('checkbox', { name: templateIds[1], exact: true }).check();
    await page.getByRole('button', { name: 'Save content type', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Content type saved.');
    expect(JSON.parse(readFileSync(typeFile, 'utf8'))).toMatchObject({ sort_field: 'sort_order', sort_dir: 'asc', allowed_templates: templateIds.slice(0, 2) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`type-options-${width}.png`), fullPage: true });
    await page.goto(`/app/sites/default/pages/${id}`, { waitUntil: 'networkidle' });
    await metadata();
    await expect(page.getByLabel('Page template').locator('option')).toHaveCount(3);
    await page.getByLabel('Page template').selectOption(templateIds[1]);
    await page.getByLabel('Page order', { exact: true }).fill('2');
    expect(JSON.parse(readFileSync(file, 'utf8')).template).toBeUndefined();
    await page.getByLabel('Page template').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`page-options-${width}.png`), fullPage: true });
    await save();
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).template).toBe(templateIds[1]);
    expect(JSON.parse(readFileSync(file, 'utf8')).sort_order).toBe(2);
    const preview = await page.request.get(`/api/sites/default/preview/${id}`);
    expect(preview.ok()).toBe(true);
    expect(await preview.text()).toContain(templateIds[1]);
    await page.reload({ waitUntil: 'networkidle' }); await metadata();
    await page.getByLabel('Page template').selectOption('');
    await page.getByLabel('Page order', { exact: true }).fill('');
    await save();
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).template).toBe('');
    expect(JSON.parse(readFileSync(file, 'utf8')).sort_order).toBeNull();
    const inherited = await page.request.get(`/api/sites/default/preview/${id}`);
    expect(inherited.ok()).toBe(true);
    expect(await inherited.text()).toContain(templateIds[0]);
    expect(JSON.parse(readFileSync(file, 'utf8')).blocks[0].data.html).toBe('<p>Same editable body</p>');
  } finally {
    rmSync(file, { force: true }); rmSync(typeFile, { force: true });
    rmSync(path.join(version, `pages/${id}`), { recursive: true, force: true });
    rmSync(path.join(version, `working_copies/page--${id}.json`), { force: true });
    for (const templateId of templateIds) rmSync(path.join(version, `page_templates/${templateId}.json`), { force: true });
  }
});
