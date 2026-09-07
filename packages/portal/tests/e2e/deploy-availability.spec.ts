import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.join(tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default');
for (const surface of ['editor', 'overview', 'pages']) {
  test(`${surface} resumes distribution and reveals the link automatically`, async ({ page }, testInfo) => {
    const versionFile = path.join(root, 'versions/main.json');
    const siteFile = `${root}.json`;
    const pageFile = path.join(root, 'versions/main/pages/availability.json');
    const originalVersion = existsSync(versionFile) ? readFileSync(versionFile) : null;
    const originalSite = readFileSync(siteFile);
    const version = { id: 'main', name: 'Main', kind: 'main', created_at: '2020-01-01T00:00:00Z',
      last_deployed_at: '2020-01-02T12:00:00Z', last_deployed_content_at: '2020-01-02T11:00:00Z' };
    let ready = false;
    let navigations = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    const job = () => ({ id: 'availability-test', status: ready ? 'succeeded' : 'running', phase: ready ? 'done' : 'distributing' });
    try {
      writeFileSync(siteFile, JSON.stringify({ ...JSON.parse(originalSite.toString()), domain: 'available.example.com' }));
      writeFileSync(versionFile, JSON.stringify({ ...version, distributing_deploy_id: 'new-publication' }));
      writeFileSync(pageFile, JSON.stringify({ id: 'availability', title: 'Availability test', slug: 'availability', status: 'published',
        content_mode: 'blocks', date_updated: '2020-01-02T10:00:00Z', blocks: [] }));
      await page.route('**/api/sites/default/deploy', route => route.fulfill({ json: { jobs: [job()], active_job: ready ? null : job() } }));
      await page.route('**/api/sites/default/deploys/availability-test', route => route.fulfill({ json: job() }));
      await page.setViewportSize({ width: 390, height: 844 });
      const url = surface === 'editor' ? '/app/sites/default/pages/availability' : surface === 'pages' ? '/app/sites/default/pages/posts' : '/app/sites/default';
      await page.goto(url, { waitUntil: 'networkidle' });
      if (surface === 'editor') await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Distributing' })).toBeVisible();
      await expect(page.locator('a[href^="https://available.example.com"]')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-distributing-mobile.png`) });
      // An explicit reload must resume the same job without another deploy.
      await page.reload({ waitUntil: 'networkidle' });
      const before = navigations;
      writeFileSync(versionFile, JSON.stringify(version));
      ready = true;
      await expect.poll(() => navigations, { timeout: 12_000 }).toBeGreaterThan(before);
      if (surface === 'editor') await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.locator('a[href^="https://available.example.com"]')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-ready-mobile.png`) });
      expect(errors).toEqual([]);
    } finally {
      writeFileSync(siteFile, originalSite);
      if (originalVersion) writeFileSync(versionFile, originalVersion); else rmSync(versionFile, { force: true });
      rmSync(pageFile, { force: true });
    }
  });
}
