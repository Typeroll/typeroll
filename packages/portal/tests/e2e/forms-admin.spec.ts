/**
 * Forms admin flow on the default site (dev session, bundled fixtures):
 *   - Forms list → create a form
 *   - Land on the form editor → Email tab → add an admin notification → save
 *   - Submissions tab loads
 *
 * Connector setup isn't required to author an email action (a warning shows
 * instead), so this stays self-contained.
 */
import { test, expect } from '@playwright/test';

test('create a form, attach an email action, view submissions', async ({ page }) => {
  const formId = `e2eform${Date.now()}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('/app/sites/default/forms');
  await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();

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
    await page.getByRole('button', { name: /^Actions/ }).click();
    await expect(addAdmin).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await addAdmin.click();
  await page.getByPlaceholder('you@company.com or {{email}}').fill('owner@example.com');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 });

  // Submissions tab loads (likely empty for a fresh form).
  await page.getByRole('button', { name: /^Submissions$/ }).click();
  await expect(page.getByText(/No submissions yet|partial|:/i).first()).toBeVisible({ timeout: 10_000 });

  // Cleanup: delete the form so reruns don't accumulate.
  await page.goto('/app/sites/default/forms');
  page.on('dialog', (d) => d.accept());
  const row = page.locator('.card', { hasText: formId });
  await row.getByRole('button', { name: /delete form/i }).click();
});
