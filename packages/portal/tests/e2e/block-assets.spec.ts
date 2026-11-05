import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAIN, e2eStore } from './helpers/store';
import { localFixtureDocuments, writeFixtureTree } from './seed-store.mjs';

// The portal preview reads the local E2E Worker's store; the static build reads
// a disposable fixtures tree written per test. No API credentials, customer
// content, or deployed site is involved.
const version = DEFAULT_MAIN;
const template = fileURLToPath(new URL('../../../site-template/', import.meta.url));

test('Page listing has real responsive tracks in preview and a fresh static build', async ({ page }) => {
  test.setTimeout(120_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-block-assets-'));
  const fixtures = mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-block-assets-fixtures-'));
  const pageFile = `${version}/pages/asset-listing`;
  const collectionFile = `${version}/content_types/asset-guides`;
  const itemFile = (i: number) => `${version}/pages/asset-guide-${i}`;
  const documents: Array<[string, Record<string, unknown>]> = [];
  documents.push([collectionFile, {
    id: 'asset-guides', name: 'asset-guides', label_singular: 'Guide', label_plural: 'Guides',
    fields: [{ name: 'pdf_url', label: 'PDF', type: 'url' }], route_template: '', created_at: '2026-09-07T00:00:00Z',
  }]);
  for (let i = 0; i < 3; i++) documents.push([itemFile(i), {
    id: `asset-guide-${i}`, content_type: 'asset-guides', content_mode: 'blocks', blocks: [], slug: `guide-${i}`, title: `Guide ${i}`, status: 'published',
    fields: { pdf_url: `https://media.example.test/guide-${i}.pdf` },
    created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z',
  }]);
  documents.push([pageFile, {
    id: 'asset-listing', title: 'Asset listing', slug: 'asset-listing', path: '/asset-listing/',
    status: 'published', content_mode: 'blocks', blocks: [{
      id: 'asset-list', type: 'core/page_list', data: {
        content_type: 'asset-guides', cols: { mobile: 1, tablet: 2, desktop: 3 },
        item_overrides: { show_image: false, title_field: 'title', href_field: 'pdf_url', heading_level: 'h2' },
      },
    }],
  }]);
  try {
    await e2eStore.setMany(documents);
    writeFixtureTree(fixtures, new Map([...localFixtureDocuments(), ...documents]));
    execFileSync(process.execPath, [path.join(template, '../../node_modules/astro/bin/astro.mjs'), 'build', '--outDir', out], {
      cwd: template, timeout: 60_000, encoding: 'utf8', stdio: 'pipe',
      env: {
        ...process.env, TYPEROLL_FIXTURES_DIR: fixtures,
        TYPEROLL_ORG_ID: 'default', TYPEROLL_SITE_ID: 'default', TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_SITE_URL: 'https://static-assets.test',
      },
    });
    // Serve the exact build in the browser without starting another server.
    await page.route('https://static-assets.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const file = path.resolve(out, `.${relative}`);
      if (!file.startsWith(`${out}${path.sep}`)) return route.abort();
      try {
        await route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });
    for (const url of ['/api/sites/default/preview/browse/asset-listing/', 'https://static-assets.test/asset-listing/']) {
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      const listing = url.startsWith('https://static-assets.test')
        ? page.locator('[data-bid="asset-list"]')
        : page.frameLocator('iframe').locator('[data-bid="asset-list"]');
      await expect(listing.locator('[data-block="post_card"]')).toHaveCount(3);
      await expect(listing.locator('a').first()).toHaveAttribute('href', 'https://media.example.test/guide-0.pdf');
      for (const [width, count] of [[390, 1], [768, 2], [1440, 3]]) {
        await page.setViewportSize({ width, height: 900 });
        const computed = await listing.evaluate((element) => {
          const style = getComputedStyle(element);
          return { display: style.display, tracks: style.gridTemplateColumns };
        });
        expect(computed.display, `${url} at ${width}px`).toBe('grid');
        expect(computed.tracks).not.toBe('none');
        expect(computed.tracks.trim().split(/\s+/)).toHaveLength(count);
        expect(await listing.locator('[data-block="post_card"]').first().evaluate((element) => getComputedStyle(element).display)).toBe('flex');
      }
    }
  } finally {
    await e2eStore.deleteTree(...documents.map(([document]) => document));
    rmSync(out, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  }
});
