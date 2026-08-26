// Pagefind indexing pass in the deploy runner: gated on core/search usage,
// writes the /pagefind/ assets the block's client script loads, respects
// the data-pagefind-body scope (only attributed content is indexed once
// any page carries the attribute).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSearchIndexIfUsed } from '../../lib/deploy/search-index';

async function makeSite(withSearchBlock: boolean): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tr-searchtest-'));
  const page = (title: string, body: string, extra = '') => `<!doctype html>
<html lang="en"><head><title>${title}</title></head>
<body><nav>Site nav</nav><main data-pagefind-body>${body}${extra}</main></body></html>`;
  await fs.promises.writeFile(path.join(dir, 'index.html'), page(
    'Home',
    '<h1>Welcome to Aardvark Consulting</h1><p>We herd aardvarks professionally.</p>',
    withSearchBlock ? '<div data-block="search" data-placeholder="Sök"><div class="block-search-mount"></div></div>' : '',
  ));
  await fs.promises.mkdir(path.join(dir, 'about'));
  await fs.promises.writeFile(path.join(dir, 'about', 'index.html'), page(
    'About', '<h1>About</h1><p>Founded by zebras.</p>',
  ));
  return dir;
}

describe('buildSearchIndexIfUsed', () => {
  it('skips sites without a core/search block', async () => {
    const dir = await makeSite(false);
    const result = await buildSearchIndexIfUsed(dir);
    expect(result.indexed).toBe(false);
    expect(fs.existsSync(path.join(dir, 'pagefind'))).toBe(false);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('indexes and writes the pagefind assets when the block is present', async () => {
    const dir = await makeSite(true);
    const result = await buildSearchIndexIfUsed(dir);
    expect(result.indexed).toBe(true);
    expect(result.page_count).toBe(2);
    // The assets the block's client script loads at visit time.
    expect(fs.existsSync(path.join(dir, 'pagefind', 'pagefind-ui.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'pagefind', 'pagefind-ui.css'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'pagefind', 'pagefind.js'))).toBe(true);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }, 30_000);
});
