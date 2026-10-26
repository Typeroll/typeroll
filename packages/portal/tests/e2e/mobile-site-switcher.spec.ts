import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { authenticatePersona } from './helpers/auth';
import { gotoReady } from './helpers/ready';

const root = path.join(os.tmpdir(), 'typeroll-e2e-fixtures', 'organizations', 'e2e-core', 'sites');
const ids = Array.from({ length: 20 }, (_, i) => `scroll-site-${String(i).padStart(2, '0')}`);
test.beforeAll(() => {
  mkdirSync(root, { recursive: true });
  ids.forEach((id, i) => writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ name: `Scroll site ${String(i).padStart(2, '0')}`, created_at: '2026-10-26T00:00:00Z' })));
});
test.afterAll(() => ids.forEach(id => rmSync(path.join(root, `${id}.json`), { force: true })));

for (const [width, height] of [[390, 664], [320, 480], [844, 390]]) {
  test(`the last site and New site are reachable at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await authenticatePersona(page, 'owner');
    await gotoReady(page, '/app');
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.locator('.ws__trigger').filter({ hasText: 'All sites' }).click();
    const menu = page.getByRole('listbox', { name: 'Switch site' });
    await expect(menu.getByRole('option')).toHaveCount(21);
    const last = menu.getByRole('option').last();
    const name = await last.locator('.ws__item-name').innerText();
    // Scroll as a user would. Locator.click/scrollIntoView alone would hide clipping bugs.
    await page.mouse.move(150, height / 2);
    for (let i = 0; i < 20; i++) {
      const rect = await last.boundingBox();
      if (rect && rect.y >= 0 && rect.y + rect.height <= height) break;
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(60);
    }
    const rect = (await last.boundingBox())!;
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`site-menu-${width}x${height}.png`) });
    await last.click();
    await expect(page).toHaveURL(/\/app\/sites\//);
    await expect(page.locator('.ws__name').filter({ hasText: name })).toHaveCount(1);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.locator('.ws__trigger').filter({ hasText: name }).click();
    const create = page.getByRole('listbox', { name: 'Switch site' }).getByRole('link', { name: 'New site' });
    await create.click();
    await expect(page).toHaveURL(/\/app\/sites\/new$/);
  });
}
