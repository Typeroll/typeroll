import { test, expect } from '@playwright/test';

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
  await page.goto('/app/sites/default', { waitUntil: 'networkidle' });
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
