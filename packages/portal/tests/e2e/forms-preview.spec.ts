/**
 * Forms in a preview link: a reviewer clicks a multi-step form through to
 * its success message. Validation and step changes behave as published, the
 * form is marked "Preview – nothing is sent", and no request reaches the
 * submit endpoint, so no submission is stored.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SITE = path.join(os.tmpdir(), 'typeroll-e2e-fixtures', 'organizations/default/sites/default');

test('a preview link clicks through a multi-step form without creating a submission', async ({ page, baseURL }) => {
  const id = `e2epreviewform${Date.now()}`;
  const formFile = path.join(SITE, 'forms', `${id}.json`);
  const pageFile = path.join(SITE, 'versions/main/pages', `${id}.json`);
  await fs.mkdir(path.dirname(formFile), { recursive: true });
  await fs.writeFile(formFile, JSON.stringify({
    name: 'Preview lead',
    actions: [{ type: 'email', config: { to: 'owner@example.test', subject: 'Lead' } }],
    created_at: new Date().toISOString(),
    submit_text: 'Send',
    success_message: 'Thanks, we will call you.',
    steps: [
      { id: 'contact', title: 'Contact', blocks: [
        { id: 'email', type: 'form/email', data: { name: 'email', label: 'Email', required: true } },
      ] },
      { id: 'details', title: 'Details', blocks: [
        { id: 'company', type: 'form/text', data: { name: 'company', label: 'Company', required: true } },
      ] },
    ],
  }));
  await fs.writeFile(pageFile, JSON.stringify({
    title: 'Preview form', slug: id, path: `/${id}`, content_mode: 'blocks', status: 'published',
    content_type: 'page', fields: {}, date_updated: new Date().toISOString(),
    blocks: [{ id: 'form', type: 'core/form', data: { form_id: id } }],
  }));
  try {
    const link = await page.request.post('/api/sites/default/preview-link', { headers: { Origin: new URL(baseURL!).origin }, data: { path: id } });
    expect(link.status(), await link.text()).toBe(200);
    const { url } = await link.json() as { url: string };

    const submits: string[] = [];
    page.on('request', (request) => { if (request.url().includes('/api/forms/submit')) submits.push(request.method()); });
    await page.goto(url);
    // The link opens a shell; the page renders in its isolated frame.
    const frame = page.frameLocator('iframe');
    const decline = frame.getByRole('button', { name: 'Neka' });
    if (await decline.isVisible({ timeout: 5_000 }).catch(() => false)) await decline.click();

    await expect(frame.getByRole('note')).toHaveText('Preview – nothing is sent');
    const email = frame.getByLabel('Email');
    const company = frame.getByLabel('Company');
    const send = frame.getByRole('button', { name: 'Send' });

    // The server's address rule runs in the preview too (a@b passes the browser).
    await email.fill('a@b');
    await send.click();
    await expect(frame.getByText("Email doesn't look like a valid email address")).toBeVisible();
    await expect(company).toBeHidden();

    await email.fill('ada@example.test');
    await send.click();
    await expect(company).toBeVisible();
    await expect(email).toBeHidden();

    // Step 2's required field is enforced natively before anything happens.
    await send.click();
    expect(await company.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

    await company.fill('Acme');
    await send.click();
    await expect(frame.getByRole('status')).toHaveText('Thanks, we will call you.');
    await expect(frame.getByRole('note')).toHaveText('Preview – nothing is sent');

    expect(submits).toEqual([]);

    // The editor canvas (browse embed mode) and the page preview render the
    // same way.
    for (const preview of [`/api/sites/default/preview/browse/${id}/?embed=1&interactive=1`, `/api/sites/default/preview/${id}`]) {
      const html = await (await page.request.get(preview)).text();
      expect(html).toContain('Preview – nothing is sent');
      expect(html).toContain('data-tr-preview=');
    }
    const submissions = await page.request.get(`/api/sites/default/forms/${id}/submissions`);
    expect(submissions.ok()).toBe(true);
    expect((await submissions.json() as { submissions: unknown[] }).submissions).toEqual([]);
  } finally {
    await fs.rm(formFile, { force: true });
    await fs.rm(pageFile, { force: true });
  }
});
