import { test, expect } from '@playwright/test';
import { gotoReady, reloadReady, waitForHydration } from './helpers/ready';
import { DEFAULT_MAIN, DEFAULT_SITE, e2eStore } from './helpers/store';

for (const surface of ['editor', 'overview', 'pages']) {
  test(`${surface} resumes distribution and reveals the link automatically`, async ({ page }, testInfo) => {
    const pageDoc = `${DEFAULT_MAIN}/pages/availability`;
    const originalVersion = await e2eStore.get(DEFAULT_MAIN);
    const originalSite = await e2eStore.read(DEFAULT_SITE);
    const version = { id: 'main', name: 'Main', kind: 'main', created_at: '2020-01-01T00:00:00Z',
      last_deployed_at: '2020-01-02T12:00:00Z', last_deployed_content_at: '2020-01-02T11:00:00Z' };
    let ready = false;
    let navigations = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    const job = () => ({ id: 'availability-test', status: ready ? 'succeeded' : 'running', phase: ready ? 'done' : 'distributing' });
    try {
      await e2eStore.setMany([
        [DEFAULT_SITE, { ...originalSite, domain: 'available.example.com' }],
        [DEFAULT_MAIN, { ...version, distributing_deploy_id: 'new-publication' }],
        [pageDoc, { id: 'availability', title: 'Availability test', slug: 'availability', status: 'published',
          content_mode: 'blocks', date_updated: '2020-01-02T10:00:00Z', blocks: [] }],
      ]);
      await page.route('**/api/sites/default/deploy', route => route.fulfill({ json: { jobs: [job()], active_job: ready ? null : job() } }));
      await page.route('**/api/sites/default/deploys/availability-test', route => route.fulfill({ json: job() }));
      await page.setViewportSize({ width: 390, height: 844 });
      const url = surface === 'editor' ? '/app/sites/default/pages/availability' : surface === 'pages' ? '/app/sites/default/pages' : '/app/sites/default';
      await gotoReady(page, url);
      if (surface === 'editor') await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Distributing' })).toBeVisible();
      await expect(page.locator('a[href^="https://available.example.com"]')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-distributing-mobile.png`) });
      // An explicit reload must resume the same job without another deploy.
      await reloadReady(page);
      const before = navigations;
      await e2eStore.set(DEFAULT_MAIN, version);
      ready = true;
      await expect.poll(() => navigations, { timeout: 12_000 }).toBeGreaterThan(before);
      // The page reloaded itself; act on it once the new document has hydrated.
      await waitForHydration(page);
      if (surface === 'editor') await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.locator('a[href^="https://available.example.com"]')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-ready-mobile.png`) });
      expect(errors).toEqual([]);
    } finally {
      await e2eStore.set(DEFAULT_SITE, originalSite);
      if (originalVersion) await e2eStore.set(DEFAULT_MAIN, originalVersion); else await e2eStore.delete(DEFAULT_MAIN);
      await e2eStore.deleteTree(pageDoc);
    }
  });
}
