// Pagefind search indexing — the deploy-side half of the core/search
// block. Runs over the built HTML AFTER the block-asset bundling pass and
// writes the index + UI assets to {buildDir}/pagefind/, which the block's
// client script lazy-loads at visit time.
//
// Gated on actual usage: sites without a core/search block skip the pass
// entirely (no index bytes, no extra build seconds). Index scope comes
// from data-pagefind-body on <main> — page content only (nav/footer
// excluded), and noindex pages carry no data-pagefind-body so Pagefind
// skips them wholesale.

import fs from 'node:fs';
import path from 'node:path';

const SEARCH_MARKER = 'data-block="search"';

async function anyHtmlContains(dir: string, needle: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (await anyHtmlContains(full, needle)) return true;
    } else if (e.name.endsWith('.html')) {
      const text = await fs.promises.readFile(full, 'utf8');
      if (text.includes(needle)) return true;
    }
  }
  return false;
}

export interface SearchIndexResult {
  indexed: boolean;
  page_count?: number;
}

export async function buildSearchIndexIfUsed(buildDir: string): Promise<SearchIndexResult> {
  if (!(await anyHtmlContains(buildDir, SEARCH_MARKER))) return { indexed: false };

  const pagefind = await import('pagefind');
  const { index, errors } = await pagefind.createIndex({});
  if (!index) {
    throw new Error(`pagefind createIndex failed: ${(errors ?? []).join('; ')}`);
  }
  try {
    const added = await index.addDirectory({ path: buildDir });
    await index.writeFiles({ outputPath: path.join(buildDir, 'pagefind') });
    return { indexed: true, page_count: added.page_count };
  } finally {
    await pagefind.close().catch(() => {});
  }
}
