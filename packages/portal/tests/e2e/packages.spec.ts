/**
 * Packages on the default site (dev session, bundled fixtures):
 *   - export a block template and the style it uses as a .typeroll file
 *   - import the file back: the template id is taken, so the plan renames it
 *     and the report links to the renamed copy
 *   - the imported template shows where it came from
 */
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { PORTAL_ORIGIN } from './helpers/store';

test('export a template as a package and import it again', async ({ page }, info) => {
  const name = `E2E hero ${Date.now() % 100000}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const created = await page.request.post('/api/sites/default/block-templates', {
    headers: { Origin: PORTAL_ORIGIN },
    data: { name, kind: 'section', category: 'Heroes', blocks: [{ id: 'h', type: 'core/rich_heading', data: { html: 'Welcome', style_id: 'eyebrow' } }] },
  });
  expect(created.ok()).toBe(true);
  const template = (await created.json()).block_template;
  const ids: string[] = [template.id];
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, '/app/sites/default/packages');
    await expect(page.getByRole('heading', { name: 'Export a package' })).toBeVisible();
    await page.getByRole('checkbox', { name: new RegExp(name) }).check();
    await page.getByLabel('Name', { exact: true }).fill(name);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export package' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.typeroll$/);
    const file = info.outputPath(download.suggestedFilename());
    await download.saveAs(file);

    await page.getByLabel('Choose a .typeroll file').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/vnd.typeroll.package+zip', buffer: await readFile(file) });
    await expect(page.getByRole('heading', { name: 'What the import does' })).toBeVisible();
    await expect(page.getByText(new RegExp(`Rename → ${template.id}-2`))).toBeVisible();
    await page.screenshot({ path: info.outputPath('package-plan.png'), fullPage: true });
    await page.getByRole('button', { name: `Import ${name}` }).click();
    await expect(page.getByRole('link', { name: `${template.id}-2 (was ${template.id})` })).toBeVisible();
    ids.push(`${template.id}-2`);

    await gotoReady(page, '/app/sites/default/partials');
    await expect(page.getByText(new RegExp(`From ${name} 1\\.0\\.0`))).toBeVisible();
  } finally {
    for (const id of ids) await page.request.delete(`/api/sites/default/block-templates/${id}`, { headers: { Origin: PORTAL_ORIGIN } });
  }
});
