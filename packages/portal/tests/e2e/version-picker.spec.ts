import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';
import { gotoReady } from './helpers/ready';
import { CORE_MAIN, CORE_SITE, e2eStore } from './helpers/store';

test('site navigation handles a published virtual Main alongside a branch', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  const branchDoc = `${CORE_SITE}/versions/a-version-picker-regression`;
  const originalMain = await e2eStore.get(CORE_MAIN);
  await e2eStore.setMany([
    [CORE_MAIN, { last_deployed_at: '2026-09-18T10:00:00.000Z', deploy_url: 'https://example.test' }],
    [branchDoc, { name: 'Version picker regression', kind: 'branch', base_version_id: 'main', robots_blocked: true, created_at: '2026-09-18T09:00:00.000Z' }],
  ]);
  try {
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await gotoReady(page, '/app/sites/e2e-core-site');
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
    if (originalMain) await e2eStore.set(CORE_MAIN, originalMain); else await e2eStore.delete(CORE_MAIN);
    await e2eStore.deleteTree(branchDoc);
  }
});

test('branch actions are styled before their dialog first opens', async ({ page, context }) => {
  await authenticatePersona(page, 'owner');
  const branchDoc = `${CORE_SITE}/versions/a-version-actions`;
  await e2eStore.set(branchDoc, { name: 'Version actions', kind: 'branch', base_version_id: 'main', robots_blocked: true, created_at: '2026-11-02T09:00:00.000Z' });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const response = await gotoReady(page, '/app/sites/e2e-core-site');
    expect(response?.status()).toBe(200);
    await context.addCookies([{ name: 'typeroll_version', value: 'a-version-actions', url: new URL(page.url()).origin }]);
    await gotoReady(page, '/app/sites/e2e-core-site');
    await page.getByRole('button', { name: /^Version Version actions/ }).click();
    const promote = page.getByRole('button', { name: 'Promote to main…' });
    const reset = page.getByRole('button', { name: 'Reset from main…' });
    const newBranch = page.getByRole('button', { name: 'New branch' });
    const look = (button: typeof promote) => button.evaluate(element => {
      const style = getComputedStyle(element);
      return { border: `${style.borderTopStyle} ${style.borderLeftStyle}`, background: style.backgroundColor, font: `${style.fontSize} ${style.fontWeight}`, width: (element as HTMLElement).offsetWidth, cursor: style.cursor };
    });
    const expected = { ...await look(newBranch) };
    for (const button of [promote, reset]) {
      await expect(button).toBeVisible();
      // The same menu row as "New branch": dashed top rule, no button chrome, full width.
      expect(await look(button)).toEqual(expected);
      expect(expected.border).toBe('dashed none');
      expect(await button.locator('.vp__action-icon').evaluate(icon => getComputedStyle(icon).borderTopStyle)).toBe('solid');
    }
  } finally {
    await e2eStore.deleteTree(branchDoc);
  }
});
