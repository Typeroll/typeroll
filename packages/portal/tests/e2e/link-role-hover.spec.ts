import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');
const version = path.join(fixtures, 'organizations/default/sites/default/versions/main');
const settingsFile = path.join(version, 'settings/default.json');
const pageFile = path.join(version, 'pages/link-role-hover.json');
const typeFile = path.join(version, 'content_types/hover-articles.json');
const template = fileURLToPath(new URL('../../../site-template/', import.meta.url));
const STATIC = 'https://link-role.test';

test('link role hover and mapped Page dates agree in static output and preview', async ({ page }, info) => {
  test.setTimeout(180_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'tr-link-role-'));
  const original = readFileSync(settingsFile, 'utf8');
  const settings = JSON.parse(original);
  const styles = [
    { id: 'link', name: 'Links', role: 'link', targets: ['link'], base: { color: 'primary' }, hover: { color: '#0056a0', decoration: 'underline' } },
    { id: 'own-hover', name: 'Own hover', targets: ['link', 'button'], base: {}, hover: { color: '#9b1250', decoration: 'none' } },
  ];
  writeFileSync(settingsFile, JSON.stringify({ ...settings, render_version: 11, custom_css: '', styles,
    cookie_consent: { enabled: true, privacy_policy_url: '/privacy/' } }));
  mkdirSync(path.dirname(typeFile), { recursive: true });
  writeFileSync(typeFile, JSON.stringify({ id: 'hover-articles', name: 'hover-articles', label_singular: 'Article', label_plural: 'Articles',
    route_template: '/{slug}', fields: [{ name: 'sort_order', type: 'number', label: 'Order' }], schema_type: 'Article', schema_field_mode: 'mapped',
    schema_field_map: { title: 'headline', date_published: 'datePublished', date_updated: 'dateModified' } }));
  writeFileSync(pageFile, JSON.stringify({ id: 'link-role-hover', title: 'Link role', slug: 'link-role-hover', path: '/link-role-hover/', status: 'published',
    content_type: 'hover-articles', content_mode: 'blocks', date_published: '2024-05-02T10:01:08Z', date_updated: '2024-05-03T12:00:00+02:00', fields: { sort_order: 10 },
    blocks: [
      { id: 'crumbs', type: 'template/page_breadcrumbs', data: {} },
      { id: 'prose', type: 'core/prose', data: { html: '<p><a href="/example/">Body link</a></p><h2 id="topic">Topic</h2><p>Body text.</p>' } },
      { id: 'toc', type: 'core/table_of_contents', data: { title: 'Contents' } },
      { id: 'button', type: 'core/button', data: { label: 'Own button', href: '/button/', style_id: 'own-hover' } },
      { id: 'nav', type: 'core/navigation', data: { links: [{ label: 'Own navigation', href: '/nav/' }], part_styles: { link: 'own-hover' } } },
      { id: 'card', type: 'core/post_card', data: { title: 'Own card', href: '/card/', part_styles: { title_link: 'own-hover' } } },
    ] }));
  try {
    execFileSync(process.execPath, [path.join(template, '../../node_modules/astro/bin/astro.mjs'), 'build', '--outDir', out], {
      cwd: template, timeout: 90_000, stdio: 'pipe', env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: '', TYPEROLL_FIXTURES_DIR: fixtures,
        TYPEROLL_ORG_ID: 'default', TYPEROLL_SITE_ID: 'default', TYPEROLL_VERSION_ID: 'main', TYPEROLL_SITE_URL: STATIC },
    });
    const published = readFileSync(path.join(out, 'link-role-hover/index.html'), 'utf8');
    const preview = await page.request.get('/api/sites/default/preview/link-role-hover');
    expect(preview.status()).toBe(200);
    for (const html of [published, await preview.text()]) {
      const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
      const articles = schemas.filter(schema => schema['@type'] === 'Article');
      expect(articles).toHaveLength(1);
      expect(articles[0]).toMatchObject({ headline: 'Link role', datePublished: '2024-05-02T10:01:08Z', dateModified: '2024-05-03T12:00:00+02:00' });
      for (const key of ['sort_order', 'articleBody', 'publisher']) expect(articles[0]).not.toHaveProperty(key);
      expect(html).toContain('a:hover,[data-block="table_of_contents"] a:hover{color:#0056a0;text-decoration:underline;');
    }
    await page.route(`${STATIC}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(out, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (!file.startsWith(`${out}${path.sep}`)) return route.abort();
      try { await route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    for (const [url, frame] of [[`${STATIC}/link-role-hover/`, false], ['/api/sites/default/preview/browse/link-role-hover/', true]] as const) {
      await page.goto(url);
      const scope = frame ? page.frameLocator('iframe') : page;
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        await scope.locator('html').evaluate(el => el.classList.remove('tr-consent-needed'));
        // Test mouse hover at narrow widths too; this is not a touch emulation.
        for (const selector of ['[data-block="prose"] a', '[data-block="breadcrumbs"] a', '[data-block="table_of_contents"] a']) {
          const link = scope.locator(selector).first();
          await link.hover();
          await expect(link).toHaveCSS('color', 'rgb(0, 86, 160)');
          await expect(link).toHaveCSS('text-decoration-line', 'underline');
        }
        // Native navigation is collapsed below 1024px when scripts run.
        const toggle = scope.locator('.block-navigation-toggle');
        if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
        for (const name of ['Own button', 'Own navigation', 'Own card']) {
          const link = scope.locator('[data-block="button"], [data-block="navigation"], [data-block="post_card"]').getByRole('link', { name, exact: true });
          await link.hover();
          await expect(link).toHaveCSS('color', 'rgb(155, 18, 80)');
          await expect(link).toHaveCSS('text-decoration-line', 'none');
        }
        await page.screenshot({ path: info.outputPath(`${frame ? 'preview' : 'static'}-${width}.png`), fullPage: true });
        await scope.locator('html').evaluate(el => el.classList.add('tr-consent-needed'));
        const privacy = scope.locator('.tr-consent__link');
        await privacy.hover();
        await expect(privacy).toHaveCSS('color', 'rgb(0, 86, 160)');
        await expect(privacy).toHaveCSS('text-decoration-line', 'underline');
      }
    }
  } finally {
    writeFileSync(settingsFile, original);
    rmSync(pageFile, { force: true }); rmSync(typeFile, { force: true }); rmSync(out, { recursive: true, force: true });
  }
});
