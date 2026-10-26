import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

for (const width of [390, 1440]) {
  test(`an empty inventory exposes public URL discovery at ${width}px`, async ({ page }, info) => {
    await authenticatePersona(page, 'owner');
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/sites/e2e-core-site/migration-urls/discover', async route => {
      expect(route.request().postDataJSON()).toEqual({ source_origin: 'https://source.example' });
      await route.fulfill({ json: {
        added: 1,
        discovery: { coverage: 'Public URLs only.', truncated: false, warnings: [] },
        coverage: {
          urls: [{ id: 'old-guide', path: '/old-guide', status: 'unhandled', sources: ['wp_rest'] }],
          summary: { total: 1, migrated: 0, redirected: 0, excluded: 0, unhandled: 1, matched_draft: 0 },
        },
      } });
    });
    await page.goto('/app/sites/e2e-core-site/migration');
    await expect(page.getByText('No URLs inventoried yet.')).toBeVisible();
    await page.getByText('Discover public WordPress URLs', { exact: true }).click();
    const button = page.getByRole('button', { name: 'Discover URLs', exact: true });
    await expect(button).toBeDisabled();
    await page.getByLabel('Source website').fill('https://source.example');
    await button.click();
    await expect(page.getByRole('status')).toContainText('Added 1 URLs.');
    await expect(page.getByRole('cell', { name: '/old-guide', exact: true })).toBeVisible();
    await expect(page.getByText('No URLs inventoried yet.')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const recompute = await page.getByRole('button', { name: 'Recompute' }).boundingBox();
    expect(recompute!.x + recompute!.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole('region', { name: 'Migration URL inventory' })).toHaveCSS('overflow-x', 'auto');
    await page.screenshot({ path: info.outputPath(`migration-discovery-${width}.png`), fullPage: true });
  });
}
