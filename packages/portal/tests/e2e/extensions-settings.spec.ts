import { expect, test } from '@playwright/test';

test('extension settings hydrates without React errors', async ({ page }) => {
  const hydrationErrors: string[] = [];
  const hydrationErrorPattern =
    /hydration|text content did not match|react error #(423|425)/i;

  page.on('console', (message) => {
    if (message.type() === 'error' && hydrationErrorPattern.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (hydrationErrorPattern.test(error.message)) {
      hydrationErrors.push(error.message);
    }
  });

  await page.goto('/app/sites/default/settings/extensions');
  await expect(
    page.getByRole('heading', { name: 'Extensions', exact: true }),
  ).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(hydrationErrors).toEqual([]);
});
