import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_BLOCK_TYPES } from '@typeroll/shared';
import { createStaticPublicationProject, projectStaticPublication, sealPublicationProject } from '../../../../scripts/lib/static-publication.mjs';

test('source projection preserves static cards, breadcrumb labels and layout in the actual Astro artifact', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const root = path.resolve('../..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-projection-build-'));
  const dir = path.join(temp, 'project');
  try {
    const title = 'A detailed guide with enough text to exercise the intended content width';
    const input = {
      site: { name: 'Example' }, settings: { site_name: 'Example', colors: {}, fonts: {} },
      pages: [
        { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'html', html_content: '<h1>Home</h1><a href="/guides/">Guides</a>' },
        { id: 'guides', title: 'Detailed guides and practical advice', breadcrumb_label: 'Guides', slug: 'guides', status: 'published', content_mode: 'blocks', blocks: [
          { id: 'well', type: 'core/container', data: { width: 'full', max_width_px: 1120, padding_x_px: 20 }, children: [
            { id: 'heading', type: 'template/page_title', data: {} },
            { id: 'list', type: 'core/repeater', data: { source_type: 'static', item_block: 'core/post_card', layout: 'grid', cols: '2', items: [
              { title, href: '/guides/article/', internal_note: 'must-not-export' }, { title: 'Second guide', href: '/guides/article/' },
            ], item_overrides: { show_image: false, show_excerpt: false } } },
          ] },
        ] },
        { id: 'article', title: 'Article', slug: 'article', path: '/guides/article/', parent: 'guides', status: 'published', content_mode: 'html', html_content: '<h1>Article</h1>' },
      ], contentTypes: [], forms: [], extensions: [], partials: [], blockTypes: [], pageTemplates: [], media: [], redirects: [],
    };
    const frozen = projectStaticPublication(input, { siteUrl: 'https://example.test', coreCommit: 'a'.repeat(40), publishedAt: '2026-09-21T00:00:00Z', noindex: false, coreBlockTypes: CORE_BLOCK_TYPES });
    await createStaticPublicationProject(frozen, dir);
    await fs.symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(dir);
    const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, env: {}, encoding: 'utf8', timeout: 60000 });
    const report = await fs.readFile(path.join(dir, '.publication-work/seo-report.json'));
    await testInfo.attach('publication-report', { body: report, contentType: 'application/json' });
    expect(build.status, build.stderr + build.stdout + report.toString()).toBe(0);
    const article = await fs.readFile(path.join(dir, 'dist/guides/article/index.html'), 'utf8');
    const schemas = [...article.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(m => JSON.parse(m[1]));
    expect(schemas.find(s => s['@type'] === 'BreadcrumbList').itemListElement.map((x: any) => x.name)).toEqual(['Example', 'Guides', 'Article']);
    const html = await fs.readFile(path.join(dir, 'dist/guides/index.html'), 'utf8');
    expect(html).not.toContain('must-not-export');
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'example.test') return route.abort();
      try { await route.fulfill({ body: await fs.readFile(path.join(dir, 'dist', url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' }); } catch { await route.abort(); }
    });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await expect(page.locator('[data-block="post_card"]')).toHaveCount(2);
    await expect(page.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', '/guides/article/');
    await page.setViewportSize({ width: 1280, height: 900 });
    const well = page.locator('main [data-block="container"]').first();
    await expect(well).toBeVisible();
    expect((await well.boundingBox())!.width).toBe(1120);
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`frozen-cards-${width}.png`), fullPage: true });
    }
    await testInfo.attach('publication-report', { body: await fs.readFile(path.join(dir, '.publication-work/seo-report.json')), contentType: 'application/json' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
