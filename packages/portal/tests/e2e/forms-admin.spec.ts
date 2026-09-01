/**
 * Forms admin flow on the default site (dev session, bundled fixtures):
 *   - Forms list → create a form
 *   - Land on the form editor → submit through the public API
 *   - Actions tab → add an admin notification → save
 *   - Submissions remain readable and usable across mobile breakpoints
 *
 * Connector setup isn't required to author an email action (a warning shows
 * instead), so this stays self-contained.
 */
import { test, expect, type Page } from '@playwright/test';

async function expectMobileAdminLayout(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));

  const metrics = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.app-shell__mobile-bar-toggle');
    const main = document.querySelector<HTMLElement>('.app-main');
    const tabs = [...document.querySelectorAll<HTMLElement>('.form-editor__tab')];
    const barBox = bar?.getBoundingClientRect();
    const mainBox = main?.getBoundingClientRect();
    return {
      barHeight: barBox?.height ?? 0,
      barBottom: barBox?.bottom ?? 0,
      mainTop: mainBox?.top ?? 0,
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      tabColors: tabs.map((tab) => getComputedStyle(tab).color),
      tabHeights: tabs.map((tab) => tab.getBoundingClientRect().height),
    };
  });

  expect(metrics.barHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.barHeight).toBeLessThanOrEqual(64);
  expect(Math.abs(metrics.mainTop - metrics.barBottom)).toBeLessThanOrEqual(1);
  expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.tabColors.length).toBe(3);
  expect(metrics.tabColors).not.toContain('rgb(255, 255, 255)');
  expect(metrics.tabHeights.every((height) => height >= 44)).toBe(true);
}

test('create a form, attach an email action, and manage a submission on mobile', async ({ page }) => {
  const formId = `e2eform${Date.now()}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/sites/default/forms');
  await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();

  // The compact header must occupy its content height, not a stretched share
  // of the viewport. The forms list must not create horizontal page scrolling.
  const listMetrics = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.app-shell__mobile-bar-toggle')!.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>('.app-main')!.getBoundingClientRect();
    return {
      barHeight: bar.height,
      gap: Math.abs(main.top - bar.bottom),
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(listMetrics.barHeight).toBeGreaterThanOrEqual(44);
  expect(listMetrics.barHeight).toBeLessThanOrEqual(64);
  expect(listMetrics.gap).toBeLessThanOrEqual(1);
  expect(listMetrics.contentWidth).toBeLessThanOrEqual(listMetrics.viewportWidth);

  // The "New form" button is server-rendered; clicking only toggles state once
  // the React island hydrates. Retry the click until the create panel appears.
  const idInput = page.getByPlaceholder('contact', { exact: true });
  await expect(async () => {
    await page.getByRole('button', { name: /new form/i }).click();
    await expect(idInput).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await idInput.fill(formId);
  await page.getByPlaceholder('Contact form', { exact: true }).fill('E2E Form');
  await page.getByRole('button', { name: /^create$/i }).click();

  // Lands on the editor.
  await expect(page).toHaveURL(new RegExp(`/forms/${formId}`));
  await expect(page.getByRole('heading', { name: 'E2E Form' })).toBeVisible();

  // Create one real submission. This catches both the collapsed-row text that
  // disappeared when it inherited .btn's white foreground and the narrow
  // detail layout that used to rely on a desktop table.
  const tokenResponse = await page.request.get(`/api/sites/default/forms/${formId}/token`);
  expect(tokenResponse.ok()).toBe(true);
  const { token } = await tokenResponse.json() as { token: string };
  const submissionResponse = await page.request.post('/api/forms/submit', {
    data: {
      token,
      data: { email: 'mobile@example.test', _protocol: '1', _hp: '' },
    },
  });
  expect(submissionResponse.ok()).toBe(true);
  await expect(submissionResponse.json()).resolves.toMatchObject({ ok: true, done: true });

  // Actions tab → add an admin notification → fill recipient → save.
  // The tab was labelled "Email" until actions became generic (pre-submit
  // hooks, app-contributed types); the internal tab id is still 'email'.
  //
  // Retry the tab click for the same reason "New form" above needs it: the
  // heading is server-rendered, so the assertion above passes before the React
  // island hydrates and an early click is a no-op. The editor's bundle grew
  // with the generic action editor, which widened that window enough to make
  // a single click flaky.
  const addAdmin = page.getByRole('button', { name: /admin notification/i });
  await expect(async () => {
    await page.getByRole('tab', { name: /^Actions/ }).click();
    await expect(addAdmin).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await addAdmin.click();
  await page.getByPlaceholder('you@company.com or {{email}}').fill('owner@example.com');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 });

  // The submission summary and its values are visible without inheriting the
  // filled button's white text color.
  await page.getByRole('tab', { name: /^Submissions$/ }).click();
  const submissionToggle = page.getByRole('button', { name: /Submission.*mobile@example\.test/i });
  await expect(submissionToggle).toBeVisible({ timeout: 10_000 });
  await expect(submissionToggle).toHaveCSS('color', 'rgb(28, 25, 23)');

  for (const width of [320, 390, 480, 768, 960]) {
    await expectMobileAdminLayout(page, width);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await submissionToggle.click();
  await expect(page.locator('.submission-data')).toContainText('email');
  await expect(page.locator('.submission-data')).toContainText('mobile@example.test');
  await expect(page.getByRole('button', { name: 'Delete submission' })).toHaveCSS('width', '40px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // The adjacent email settings surface uses the same shell and its test-email
  // controls stack instead of overflowing at phone width.
  await page.goto('/app/sites/default/settings/email');
  await expect(page.getByRole('heading', { name: 'Email & notifications' })).toBeVisible();
  await expect(page.locator('.email-test-row')).toHaveCSS('flex-direction', 'column');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Cleanup: delete the form so reruns don't accumulate.
  await page.goto('/app/sites/default/forms');
  page.on('dialog', (d) => d.accept());
  const row = page.locator('.card', { hasText: formId });
  await row.getByRole('button', { name: /delete form/i }).click();
});
