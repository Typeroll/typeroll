import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';

test('site navigation handles a published virtual Main alongside a branch', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  const versions = path.join(os.tmpdir(), 'typeroll-e2e-fixtures', 'organizations/e2e-core/sites/e2e-core-site/versions');
  const mainFile = path.join(versions, 'main.json');
  const branchFile = path.join(versions, 'a-version-picker-regression.json');
  const originalMain = existsSync(mainFile) ? readFileSync(mainFile) : null;
  mkdirSync(versions, { recursive: true });
  writeFileSync(mainFile, JSON.stringify({ last_deployed_at: '2026-09-18T10:00:00.000Z', deploy_url: 'https://example.test' }));
  writeFileSync(branchFile, JSON.stringify({ name: 'Version picker regression', kind: 'branch', base_version_id: 'main', robots_blocked: true, created_at: '2026-09-18T09:00:00.000Z' }));
  try {
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto('/app/sites/e2e-core-site', { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Typeroll E2E Core Site', exact: true })).toBeVisible();
      if (width < 768) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Version Main', exact: true }).click();
      await expect(page.getByRole('listbox', { name: 'Switch version' }).getByRole('option').first()).toContainText('Main');
      await expect(page.getByRole('listbox', { name: 'Switch version' }).getByRole('option').first()).toContainText('production');
      await expect(page.getByRole('option', { name: /Version picker regression/ })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`published-main-navigation-${width}.png`), animations: 'disabled' });
    }
  } finally {
    if (originalMain) writeFileSync(mainFile, originalMain); else rmSync(mainFile, { force: true });
    rmSync(branchFile, { force: true });
  }
});
