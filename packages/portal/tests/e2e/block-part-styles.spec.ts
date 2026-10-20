/**
 * Block part styles (docs/plans/block-parts.md): a site style applied to the
 * link part of core/rich_heading removes the underline on every instance, an
 * instance's own part style wins over it, and the portal preview and a fresh
 * static build emit the same part CSS and render the same result.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The local Playwright server owns this disposable tree (see playwright.config).
const fixtures = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');
const version = path.join(fixtures, 'organizations/default/sites/default/versions/main');
const settingsFile = path.join(version, 'settings/default.json');
const pageFile = path.join(version, 'pages/part-styles.json');
const template = fileURLToPath(new URL('../../../site-template/', import.meta.url));
const STATIC = 'https://part-styles.test';

const styles = [
  // Site-wide: every formatted heading link, without an underline until hover.
  { id: 'e2e-quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none' }, hover: { decoration: 'underline' }, parts: ['core/rich_heading.link'] },
  // Chosen by one block for its link part.
  { id: 'e2e-strong-link', name: 'Strong link', targets: ['link'], base: { decoration: 'underline', weight: 700 }, hover: { decoration: 'none' } },
];
const heading = (id: string, data: Record<string, unknown> = {}) => ({
  id, type: 'core/rich_heading', data: { level: 'h2', anchor_id: id, html: '<a href="/">Avtal du behöver tänka på vid flytt</a>', ...data },
});

/** The block part rules of a document: the text after the marker up to the end of its style element. */
function partCss(html: string): string {
  const start = html.indexOf('/* block parts */');
  expect(start, 'the page carries block part CSS').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</style>', start)).trim();
}

const link = (page: Page, frame: boolean, id: string) => (frame ? page.frameLocator('iframe').locator(`#${id} a`) : page.locator(`#${id} a`));

test('a site-wide part style removes the heading link underline and an instance part style wins, in preview and published', async ({ page }) => {
  test.setTimeout(150_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-part-styles-'));
  const originalSettings = readFileSync(settingsFile, 'utf8');
  const settings = JSON.parse(originalSettings) as { styles?: unknown[]; cookie_consent?: Record<string, unknown> };
  mkdirSync(path.dirname(pageFile), { recursive: true });
  // The consent banner would cover the links the test hovers.
  writeFileSync(settingsFile, JSON.stringify({ ...settings, cookie_consent: { ...settings.cookie_consent, enabled: false }, styles: [...(settings.styles ?? []), ...styles] }, null, 2));
  writeFileSync(pageFile, JSON.stringify({
    id: 'part-styles', title: 'Part styles', slug: 'part-styles', path: '/part-styles/', status: 'published', content_mode: 'blocks',
    blocks: [heading('site-wide'), heading('own-choice', { part_styles: { link: 'e2e-strong-link' } })],
  }));
  try {
    execFileSync(process.execPath, [path.join(template, '../../node_modules/astro/bin/astro.mjs'), 'build', '--outDir', out], {
      cwd: template, timeout: 90_000, encoding: 'utf8', stdio: 'pipe',
      env: {
        ...process.env, FIREBASE_SERVICE_ACCOUNT: '', TYPEROLL_FIXTURES_DIR: fixtures,
        TYPEROLL_ORG_ID: 'default', TYPEROLL_SITE_ID: 'default', TYPEROLL_VERSION_ID: 'main', TYPEROLL_SITE_URL: STATIC,
      },
    });
    const published = readFileSync(path.join(out, 'part-styles/index.html'), 'utf8');
    // Serve the exact build in the browser without starting another server.
    await page.route(`${STATIC}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const file = path.resolve(out, `.${relative}`);
      if (!file.startsWith(`${out}${path.sep}`)) return route.abort();
      try {
        await route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });

    // The preview renders the saved page with the same block part CSS.
    const preview = await page.request.get('/api/sites/default/preview/part-styles');
    expect(preview.status()).toBe(200);
    expect(partCss(await preview.text())).toBe(partCss(published));
    expect(published).toMatch(/<h2 data-block="rich_heading"[^>]* data-part-link="e2e-strong-link"/);

    for (const [url, frame] of [['/api/sites/default/preview/browse/part-styles/', true], [`${STATIC}/part-styles/`, false]] as const) {
      expect((await page.goto(url))?.status()).toBe(200);
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        // Off the links: a hover from the previous width must not carry over.
        await page.mouse.move(width - 1, 799);
        const where = `${url} at ${width}px`;
        await expect(link(page, frame, 'site-wide'), where).toHaveCSS('text-decoration-line', 'none');
        await expect(link(page, frame, 'own-choice'), where).toHaveCSS('text-decoration-line', 'underline');
        await expect(link(page, frame, 'own-choice'), where).toHaveCSS('font-weight', '700');
        // Hover follows each block's own part style; the site-wide one does not leak in.
        await link(page, frame, 'own-choice').hover();
        await expect(link(page, frame, 'own-choice'), where).toHaveCSS('text-decoration-line', 'none');
        await link(page, frame, 'site-wide').hover();
        await expect(link(page, frame, 'site-wide'), where).toHaveCSS('text-decoration-line', 'underline');
      }
    }
  } finally {
    writeFileSync(settingsFile, originalSettings);
    rmSync(pageFile, { force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
