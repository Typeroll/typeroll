import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

for (const width of [375, 1280]) test(`publication diagnostics remain actionable after reload at ${width}px`, async ({ page }, info) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/sites/e2e-core-site/deploy', route => route.fulfill({ json: { latest_job: {
    id: 'seo-local-proof', status: 'succeeded', seo_report: { checked_pages: 9, error_count: 0, warning_count: 1, errors: [], warnings: [{
      code: 'metadata_duplicate', url: 'https://example.test/companies/long-company-profile/',
      message: 'Description duplicates another profile.', remediation: 'Review the page metadata without inventing facts.',
      source: { file: 'companies/long-company-profile/index.html', line: 3, field: 'seo_description' },
    }] },
  } } }));
  await page.goto('/app/sites/e2e-core-site/pages/home', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const summary = page.getByText('Publication checks: 0 errors · 1 editorial warnings', { exact: true });
  await summary.click();
  const report = page.locator('.pmenu__validation');
  await expect(report).toContainText('seo_description');
  await expect(report).toContainText('Review the page metadata without inventing facts.');
  expect(await report.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`publication-report-${width}.png`) });
  expect(errors).toEqual([]);
  await page.goto('/app/sites/e2e-core-site/settings', { waitUntil: 'networkidle' });
  await page.getByText('Editorial publication checks', { exact: true }).click();
  await expect(page.getByLabel('Internal phrases to flag (one per line)')).toBeVisible();
  await page.getByLabel('Internal phrases to flag (one per line)').fill('internal research note');
  await page.getByLabel('Editorial constraints for reviewers (one per line)').fill('Prefer supported facts.');
  await page.getByText('Editorial publication checks', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`publication-settings-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
