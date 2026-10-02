/**
 * Multi-step form with a required field in a later step, in every browser
 * engine (this spec also runs in the firefox and webkit projects).
 *
 * Every step renders inside one <form>; later steps are only `hidden`. The
 * browser's native validation used to check their required controls too, so
 * submitting step 1 failed silently ("An invalid form control … is not
 * focusable"). The page is the published-site markup (renderFormHtml + the
 * forms runtime) served from the portal origin, posting to the real submit
 * endpoint with a real form token.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCoreBlockRegistry, FORM_SHELL_CSS, FORMS_RUNTIME_JS, renderFormHtml, type Form } from '@typeroll/shared';

const FIXTURES = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');
const FORMS_DIR = path.join(FIXTURES, 'organizations/default/sites/default/forms');
// forms-signing.ts POW_BITS: with a proof the per-IP budget is the normal one.
const POW_BITS = 15;

test('a required field in step 2 does not block step 1 and is enforced in step 2', async ({ page, browserName, baseURL }) => {
  const formId = `e2emultistep${browserName}${Date.now()}`;
  const form: Form = {
    id: formId,
    name: 'Multi-step lead',
    actions: [],
    created_at: new Date().toISOString(),
    success_message: 'Thanks, we will be in touch.',
    submit_text: 'Send',
    steps: [
      { id: 'contact', title: 'Contact', blocks: [
        { id: 'email', type: 'form/email', data: { name: 'email', label: 'Email', required: true } },
      ] },
      { id: 'details', title: 'Details', blocks: [
        { id: 'company', type: 'form/text', data: { name: 'company', label: 'Company', required: true } },
      ] },
    ],
  };
  const { id: _id, ...doc } = form;
  await fs.mkdir(FORMS_DIR, { recursive: true });
  await fs.writeFile(path.join(FORMS_DIR, `${formId}.json`), JSON.stringify(doc));
  try {
    const tokenResponse = await page.request.get(`/api/sites/default/forms/${formId}/token`);
    expect(tokenResponse.ok()).toBe(true);
    const { token } = await tokenResponse.json() as { token: string };

    const origin = new URL(baseURL!).origin;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lead</title></head><body><main>${renderFormHtml(
      form,
      { submit_url: `${origin}/api/forms/submit`, submit_token: token },
      { registry: buildCoreBlockRegistry(), pow_bits: POW_BITS, lang: 'en' },
    )}<style>${FORM_SHELL_CSS}</style><script>${FORMS_RUNTIME_JS}</script></main></body></html>`;
    await page.route(`${origin}/__e2e/forms/${formId}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    // Rate limits are per client IP; give this run its own.
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.250.${browserName.length}.${Date.now() % 250}` });

    const posts: string[] = [];
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/forms/submit')) posts.push(request.postData() ?? ''); });
    await page.goto(`${origin}/__e2e/forms/${formId}`);

    const email = page.getByLabel('Email');
    const company = page.getByLabel('Company');
    const send = page.getByRole('button', { name: 'Send' });
    await expect(email).toBeVisible();
    await expect(company).toBeHidden();

    // Step 1's own requirement is still enforced natively.
    await send.click();
    expect(await email.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    expect(posts).toHaveLength(0);

    await email.fill('ada@example.test');
    await send.click();
    await expect(company).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('ada@example.test');
    expect(posts[0]).not.toContain('name="company"');

    // Step 2's requirement now applies; nothing is posted while it is empty.
    await send.click();
    expect(await company.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);

    await company.fill('Acme');
    // The server refuses a step faster than a human moves (1.5 s).
    await page.waitForTimeout(1600);
    await send.click();
    await expect(page.getByRole('status')).toHaveText('Thanks, we will be in touch.');
    expect(posts).toHaveLength(2);

    const submissions = await page.request.get(`/api/sites/default/forms/${formId}/submissions`);
    expect(submissions.ok()).toBe(true);
    const { submissions: list } = await submissions.json() as { submissions: Array<{ status?: string; data: Record<string, unknown> }> };
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'complete', data: { email: 'ada@example.test', company: 'Acme' } });
  } finally {
    await fs.rm(path.join(FORMS_DIR, `${formId}.json`), { force: true });
  }
});
