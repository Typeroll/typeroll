import { expect, test } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

test('account shows the running Typeroll Core version', async ({ page, request }) => {
  await authenticatePersona(page, 'owner');

  const versionResponse = await request.get('/api/version');
  expect(versionResponse.ok()).toBe(true);
  const manifest = await versionResponse.json() as { core_version: string };

  await page.goto('/app/settings');

  await expect(page.locator('[data-typeroll-version]'))
    .toHaveText(`Typeroll v${manifest.core_version}`);
});
