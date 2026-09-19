import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '@typeroll/shared';
import { ownerReviewMessage } from '../../src/lib/owner-review-message';
import { authenticatePersona } from './helpers/auth';
const org = 'e2e-core', site = 'e2e-core-site';
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function write(path: string, body: unknown) {
  if ((process.env.TYPEROLL_E2E_TARGET ?? 'local') !== 'local') throw Error('Synthetic fixture only supports local execution');
  const file = join(tmpdir(), 'typeroll-e2e-fixtures', path + '.json'); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(body)); return file;
}
for (const width of [375, 1280]) test(`private review and admin queue at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const id = hash(`synthetic-${width}`), token = 'b'.repeat(43), pageId = `owner-review-${width}`, typeId = 'review-example';
  const schema = { id: typeId, name: typeId, fields: [{ name: 'online', label: 'Online support?', type: 'boolean', writable_by: ['owner', 'portal', 'import'] }] };
  const content = { id: pageId, title: 'Synthetic Company', content_type: typeId, status: 'published', fields: { online: null } };
  await write(paths.contentType(org, site, typeId), schema);
  const contentFile = await write(paths.page(org, site, pageId), content);
  const proposalPath = `organizations/${org}/sites/${site}/owner_proposals/${id}`;
  await write(proposalPath, { id, page_id: pageId, title: content.title, version_id: 'main', content_type: typeId,
    installation_id: 'synthetic-app', subject_id: 'a'.repeat(64), base_revision: hash(content), schema_revision: hash(schema),
    before: { online: null }, changes: { online: false }, fingerprint: 'synthetic', status: 'pending', created_at: new Date().toISOString(),
    review: { hash: createHash('sha256').update(token).digest('hex'), encrypted_token: 'unused-in-browser-test', expires_at: Date.now() + 86400000 },
    notification: { status: 'failed', attempts: 1 },
  });
  await write(`organizations/${org}/sites/${site}/private_settings/owner_review`, { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
  const query = `org=${org}&site=${site}&version=main&proposal=${id}`;
  const message = ownerReviewMessage({ title: content.title, before: { online: null }, changes: { online: false },
    labels: { online: 'Online support?' }, url: `https://cms.example.test/review/owner-changes?${query}#${token}`, expiresAt: Date.now() + 86400000 });
  await page.setContent('<main style="max-width:42rem;margin:auto;padding:1.25rem;font:16px/1.5 system-ui;overflow-wrap:anywhere"><h1 style="font-size:1.4rem"></h1><pre style="white-space:pre-wrap;font:inherit"></pre></main>');
  await page.locator('h1').evaluate((node, text) => { node.textContent = text; }, message.subject);
  await page.locator('pre').evaluate((node, text) => { node.textContent = text; }, message.text);
  await page.screenshot({ path: info.outputPath(`review-email-${width}.png`), fullPage: true });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/review/owner-changes?${query}#${token}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Review Synthetic Company' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByLabel('No', { exact: true })).toBeChecked();
  expect(JSON.parse(await readFile(contentFile, 'utf8')).fields.online).toBeNull();
  await page.screenshot({ path: info.outputPath(`private-review-${width}.png`), fullPage: true });
  await page.getByLabel('Yes', { exact: true }).check();
  await page.getByRole('button', { name: 'Approve changes' }).click();
  await expect(page.getByText('Proposal approved. No website has been published.')).toBeVisible();
  const accepted = JSON.parse(await readFile(contentFile, 'utf8'));
  expect(accepted.fields.online).toBe(true); expect(accepted._provenance.online.source).toBe('portal');
  const decided = JSON.parse(await readFile(join(tmpdir(), 'typeroll-e2e-fixtures', proposalPath + '.json'), 'utf8'));
  expect(decided.changes.online).toBe(false); expect(decided.decision.adjustments.online).toBe(true);
  const scanner = await page.request.get(`/api/owner-review?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(scanner.status()).toBe(200); expect(scanner.headers()['cache-control']).toContain('no-store');
  await page.goto('about:blank');
  await page.goto(`/review/owner-changes?${query}#${'c'.repeat(43)}`);
  await expect(page.getByRole('status')).toContainText('expired or was revoked');
  await page.screenshot({ path: info.outputPath(`expired-review-${width}.png`), fullPage: true });
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings`);
  await page.getByRole('link', { name: 'Review owner changes →' }).click();
  await expect(page.getByRole('heading', { name: 'Owner change review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Reviewer email')).toHaveValue('reviewer@example.test');
  await expect(page.getByText('approved · Notification failed (1/3 attempts)').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
  await page.screenshot({ path: info.outputPath(`review-admin-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
