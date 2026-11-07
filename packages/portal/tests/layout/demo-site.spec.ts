/**
 * The demo site (demo-site.ts) builds with the real renderer, uses every core
 * block type a page can hold, has no custom CSS and meets the layout contract
 * at every width. TYPEROLL_DEMO_DIST=<empty directory> keeps the built site.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { buildCoreBlockRegistry } from '@typeroll/shared';
import { publicationBuildHarness } from '../../../../scripts/lib/publication-build-harness.mjs';
import { demoSite } from './demo-site';
import { writeDemoImages } from './demo-media';
import { measureLayout } from './layout-checks';

const WIDTHS = [320, 375, 768, 1024, 1280, 1920];
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

test.setTimeout(10 * 60_000);

test('the demo site uses every block type, has no custom CSS and meets the layout contract', async ({ page }) => {
  const { pages, publication } = demoSite();
  const used = new Set<string>();
  const walk = (blocks: { type: string; children?: unknown[]; slots?: unknown[][] }[]) => { for (const block of blocks) { used.add(block.type); walk((block.children ?? []) as never); for (const slot of block.slots ?? []) walk(slot as never); } };
  for (const p of [...publication.pages, ...publication.partials, ...publication.pageTemplates]) walk(p.blocks as never);
  // A collection block (pricing table, team grid, logo cloud…) renders its items as their own block type.
  const registry = buildCoreBlockRegistry();
  for (const id of [...used]) { const item = registry.get(id)?.expand_to?.defaults?.item_block; if (typeof item === 'string') used.add(item); }
  const missing = [...registry.keys()].filter(id => !used.has(id) && !id.startsWith('form/') && !id.startsWith('template/') && !['template_content_slot', 'core/form', 'core/repeater'].includes(id));
  expect(missing, 'block types the demo does not use').toEqual([]);
  expect(publication.settings.custom_css ?? '').toBe('');

  const harness = await publicationBuildHarness(publication);
  try {
    await harness.run(true);
    const dist = path.join(harness.destination, 'dist');
    await writeDemoImages(dist);
    if (process.env.TYPEROLL_DEMO_DIST) await fs.cp(dist, process.env.TYPEROLL_DEMO_DIST, { recursive: true });
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://demo');
      let file = path.join(dist, decodeURIComponent(url.pathname));
      if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
      try { const body = await fs.readFile(file); response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const problems: string[] = [];
    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const pathname of pages) {
          await page.goto(origin + pathname, { waitUntil: 'load' });
          // Measure with the real web fonts, not the fallback shown while they load.
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          // A reader who scrolls the whole page has seen every entrance animation end; measure that page.
          await page.evaluate(() => document.querySelectorAll('[data-motion-item]').forEach(element => element.setAttribute('data-motion-in', 'done')));
          const broken = await page.evaluate(() => [...document.images].filter(image => image.complete && image.naturalWidth === 0 && image.checkVisibility()).map(image => image.getAttribute('src')));
          for (const src of broken) problems.push(`${pathname} @${width} broken_image ${src}`);
          for (const problem of await page.evaluate(measureLayout)) problems.push(`${pathname} @${width} ${problem.check} ${problem.block}: ${problem.detail}`);
        }
      }
    } finally { server.close(); }
    expect([...new Set(problems)]).toEqual([]);
  } finally {
    await harness.cleanup();
  }
});

