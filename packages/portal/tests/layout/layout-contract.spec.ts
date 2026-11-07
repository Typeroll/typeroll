/**
 * Layout contract: every core block type and page template starter, built by
 * the real static renderer with the native header and footer, meets the rules
 * in layout-checks.ts at every width. Known failures are listed in
 * layout-baseline.json (the backlog of docs/plans/responsive-defaults-and-cascade.md);
 * a new failure, or a listed one that no longer occurs, fails the suite.
 * Update the list with TYPEROLL_LAYOUT_BASELINE=write.
 */
import { expect, test } from '@playwright/test';
import { writeDemoImages } from './demo-media';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationBuildHarness } from '../../../../scripts/lib/publication-build-harness.mjs';
import { layoutGallery } from './gallery';
import { measureLayout, type LayoutProblem } from './layout-checks';

const WIDTHS = [320, 375, 768, 1024, 1280, 1920];
const BASELINE = fileURLToPath(new URL('./layout-baseline.json', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);

test('every block type and page template meets the layout contract at every width', async ({ page }, testInfo) => {
  const { pages, publication } = layoutGallery();
  const harness = await publicationBuildHarness(publication);
  try {
    await harness.run(true);
    const dist = path.join(harness.destination, 'dist');
    await writeDemoImages(dist);
    // Keep the built gallery for inspection: TYPEROLL_LAYOUT_DIST=<empty directory>.
    if (process.env.TYPEROLL_LAYOUT_DIST) await fs.cp(dist, process.env.TYPEROLL_LAYOUT_DIST, { recursive: true });
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://gallery');
      let file = path.join(dist, decodeURIComponent(url.pathname));
      if (!file.startsWith(dist)) { response.writeHead(403).end(); return; }
      if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
      try { const body = await fs.readFile(file); response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const found = new Map<string, LayoutProblem & { page: string; width: number }>();
    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const pathname of pages) {
          await page.goto(origin + pathname, { waitUntil: 'load' });
          // Measure with the real web fonts, not the fallback shown while they load.
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          // A reader who scrolls the whole page has seen every entrance animation end; measure that page.
          await page.evaluate(() => document.querySelectorAll('[data-motion-item]').forEach(element => element.setAttribute('data-motion-in', 'done')));
          for (const problem of await page.evaluate(measureLayout)) {
            const key = `${pathname} @${width} ${problem.check} ${problem.block}`;
            if (!found.has(key)) found.set(key, { ...problem, page: pathname, width });
          }
        }
      }
    } finally { server.close(); }
    const current = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([key, problem]) => [key, problem.detail]));
    await fs.writeFile(testInfo.outputPath('layout-problems.json'), JSON.stringify(current, null, 2));
    if (process.env.TYPEROLL_LAYOUT_BASELINE === 'write') {
      await fs.writeFile(BASELINE, JSON.stringify(current, null, 2) + '\n');
      return;
    }
    const baseline = JSON.parse(await fs.readFile(BASELINE, 'utf8').catch(() => '{}')) as Record<string, string>;
    expect(Object.keys(current).filter(key => !(key in baseline)), 'new layout problems (see layout-problems.json)').toEqual([]);
    expect(Object.keys(baseline).filter(key => !(key in current)), 'fixed problems still listed in layout-baseline.json').toEqual([]);
  } finally {
    await harness.cleanup();
  }
});
