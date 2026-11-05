import type { Page } from '@playwright/test';

/**
 * The seeded fixture sites predate customer publishing, so their real
 * readiness asks for a migration (managed publishing is gone) and the publish
 * controls show "Publishing setup required". Specs about those controls, which
 * already stub the deploy endpoints, report the site ready here and keep the
 * rest of the real readiness response (its publication targets).
 */
export async function stubPublishingReady(page: Page, siteId = 'default'): Promise<void> {
  await page.route(`**/api/sites/${siteId}/publishing`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), ready: true, required: [] } });
  });
}
