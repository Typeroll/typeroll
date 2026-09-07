import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const siteRoot = path.join(tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default');

for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
  test(`live links wait for deployed content and mobile deploy stays visible at ${width}x${height}`, async ({ page }, testInfo) => {
    const versionFile = path.join(siteRoot, 'versions/main.json');
    const siteFile = `${siteRoot}.json`;
    const pageFile = path.join(siteRoot, 'versions/main/pages/deploy-visibility.json');
    const originalVersion = existsSync(versionFile) ? readFileSync(versionFile) : null;
    const originalSite = readFileSync(siteFile);
    const content = { id: 'deploy-visibility', title: 'Deploy visibility', slug: 'deploy-visibility', status: 'published',
      content_mode: 'blocks', date_updated: '2020-01-02T10:00:00.000Z', blocks: [] };
    const version = { id: 'main', name: 'Main', kind: 'main', created_at: '2020-01-01T00:00:00.000Z' };
    try {
      writeFileSync(siteFile, JSON.stringify({ ...JSON.parse(originalSite.toString()), domain: 'test-site.example.com' }));
      writeFileSync(versionFile, JSON.stringify(version));
      writeFileSync(pageFile, JSON.stringify(content));
      await page.setViewportSize({ width, height });
      await page.goto('/app/sites/default/pages/deploy-visibility', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Live URL' })).toHaveCount(0);
      const deploy = page.getByRole('button', { name: 'Deploy site', exact: true });
      await expect(deploy).toBeInViewport({ ratio: 1 });
      // The footer remains visible while a long menu scrolls independently.
      await page.locator('.pmenu__body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(deploy).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`deploy-menu-${width}.png`) });
      // Exercise the actual UI request, but keep external hosting out of this local test.
      await page.route('**/api/sites/default/deploy', (route) => route.fulfill({ json: { jobId: 'visibility-test' } }));
      await page.route('**/api/sites/default/deploys/visibility-test', (route) => route.fulfill({ json: { status: 'failed', error: 'Test deployment stopped' } }));
      page.once('dialog', (dialog) => dialog.accept());
      const request = page.waitForRequest((request) => request.url().endsWith('/api/sites/default/deploy') && request.method() === 'POST');
      await deploy.click();
      expect((await request).postDataJSON()).toEqual({ environment: 'production' });
      await expect(page.getByText('Test deployment stopped', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Live URL' })).toHaveCount(0);

      // A successful live deployment makes this saved page eligible.
      writeFileSync(versionFile, JSON.stringify({ ...version, last_deployed_at: '2020-01-02T12:00:00.000Z', last_deployed_content_at: '2020-01-02T11:00:00.000Z' }));
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Live URL' })).toHaveAttribute('href', 'https://test-site.example.com/deploy-visibility');
      await page.goto('/app/sites/default/pages/posts');
      await expect(page.getByRole('row').filter({ hasText: 'Deploy visibility' }).getByTitle('Open live URL')).toHaveCount(1);
      await page.goto('/app/sites/default/pages/deploy-visibility', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await page.locator('.pmenu__body select').first().selectOption('draft');
      await expect(page.locator('.pmenu__body select').first()).toBeEnabled();
      await page.locator('.pmenu__body select').first().selectOption('published');
      await expect(page.locator('.pmenu__body select').first()).toHaveValue('published');
      await expect(page.locator('.block-editor__status')).toContainText('pending deploy');
      await expect(page.getByRole('link', { name: 'Live URL' })).toHaveCount(0);


      // Content changed while the build ran is not proven live by its completion time.
      writeFileSync(pageFile, JSON.stringify({ ...content, date_updated: '2020-01-02T11:30:00.000Z' }));
      await page.goto('/app/sites/default/pages/deploy-visibility', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Live URL' })).toHaveCount(0);
      await page.goto('/app/sites/default/pages/posts');
      await expect(page.getByRole('row').filter({ hasText: 'Deploy visibility' }).getByTitle('Open live URL')).toHaveCount(0);
    } finally {
      writeFileSync(siteFile, originalSite);
      if (originalVersion) writeFileSync(versionFile, originalVersion); else rmSync(versionFile, { force: true });
      rmSync(pageFile, { force: true });
    }
  });
}
