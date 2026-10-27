import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';

for (const width of [390, 1280]) test(`retries the same failed verification twice at ${width}px`, async ({ page }, info) => {
  let attempts = 0, polls = 0, ready = false;
  const bodies: unknown[] = [];
  const failed = { id: 'retry-test', status: 'failed', phase: 'failed', error: 'Public verification timed out.', failure: { code: 'publication_observation_timeout' } };
  await page.route('**/api/sites/default/deploy', async route => {
    if (route.request().method() === 'POST') {
      bodies.push(route.request().postDataJSON()); attempts++;
      return route.fulfill({ json: { job_id: 'retry-test', verification_only: true } });
    }
    return route.fulfill({ json: { latest_job: ready ? { ...failed, status: 'succeeded', failure: null } : failed } });
  });
  await page.route('**/api/sites/default/deploys/retry-test', route => {
    polls++;
    return route.fulfill({ json: attempts === 1 ? failed : { id: 'retry-test', status: ready ? 'succeeded' : 'running', phase: ready ? 'live' : 'retrying public verification' } });
  });
  await page.setViewportSize({ width, height: 900 });
  await gotoReady(page, '/app/sites/default');
  const retry = page.getByRole('button', { name: 'Retry verification', exact: true });
  await expect(retry).toBeVisible();
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath(`retry-${width}.png`) });
  await retry.click();
  await expect.poll(() => polls).toBe(1);
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('button', { name: 'retrying public verification…', exact: true })).toBeDisabled();
  expect(bodies).toEqual([{ retry_verification_job_id: 'retry-test' }, { retry_verification_job_id: 'retry-test' }]);
  ready = true;
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deployed ✓', exact: true })).toBeVisible({ timeout: 6000 });
});

for (const width of [390, 1280]) test(`requires explicit named-zone cache approval at ${width}px`, async ({ page }, info) => {
  const bodies: unknown[] = [];
  const failed = { id: 'cache-test', status: 'failed', phase: 'failed', error: 'Cloudflare still serves an old image. The build is complete; no rebuild is needed.', failure: { code: 'publication_cache_refresh_required' }, cache_recovery: { state: 'approval_required', zone_id: 'zone', zone_name: 'example.com' } };
  await page.route('**/api/sites/default/deploy', route => {
    if (route.request().method() === 'POST') {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { job_id: 'cache-test' } });
    }
    return route.fulfill({ json: { latest_job: failed } });
  });
  await page.route('**/api/sites/default/deploys/cache-test', route => route.fulfill({ json: { id: 'cache-test', status: 'running', phase: 'verifying refreshed cache' } }));
  await page.setViewportSize({ width, height: 900 });
  await gotoReady(page, '/app/sites/default');
  const button = page.getByRole('button', { name: 'Refresh domain cache…', exact: true });
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  expect((await page.locator('.deploy-banner__text').boundingBox())!.width).toBeGreaterThan(180);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`cache-recovery-${width}.png`) });
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('example.com');
    expect(dialog.message()).toContain('including other websites and subdomains');
    await dialog.dismiss();
  });
  await button.click();
  expect(bodies).toEqual([]);
  page.once('dialog', async dialog => { await dialog.accept(); });
  await button.click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies).toEqual([{ retry_verification_job_id: 'cache-test', approve_cache_zone_id: 'zone' }]);
  await expect(page.getByRole('button', { name: 'verifying refreshed cache…', exact: true })).toBeDisabled();
});
