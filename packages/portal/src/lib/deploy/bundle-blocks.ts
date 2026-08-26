// Post-build asset rollup for the block library.
//
// `astro build` emits per-page inlined CSS + JS for the blocks each page
// uses (BaseLayout writes `<style data-blocks="1">` and a
// `<script data-blocks="1">` wrapper). For multi-page sites this means
// the same block CSS ships in every HTML file's body — wasted bytes,
// no cross-page HTTP cache hit.
//
// This pass extracts those inline assets, unions them into one hashed
// file per type, writes them under `dist/_assets/`, and replaces each
// page's inline tag with a `<link>` / `<script src>` pointing at the
// shared bundle. The result: one bundled CSS download cached forever
// for every page on the site, no per-page CSS bytes in the HTML.
//
// Inputs and outputs are pure file I/O — no datastore, no env. Safe
// to run during a build subprocess after astro finishes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STYLE_RE = /<style data-blocks="1">([\s\S]*?)<\/style>/g;
const SCRIPT_RE = /<script data-blocks="1">([\s\S]*?)<\/script>/g;

export interface BundleResult {
  css_url?: string;
  js_url?: string;
  files_rewritten: number;
  css_bytes_saved: number;
  js_bytes_saved: number;
}

/**
 * Walk `${buildDir}/**\/*.html`, extract every `<style data-blocks="1">`
 * and `<script data-blocks="1">`, write the deduplicated union to
 * `_assets/blocks-{hash}.css` / `.js`, and rewrite each HTML file to
 * reference the shared file instead.
 */
export async function bundleBlockAssets(buildDir: string): Promise<BundleResult> {
  const htmlFiles = await listHtmlFiles(buildDir);

  // First pass: collect unique CSS and JS chunks. Duplicates across pages
  // are dropped — a chunk's content is its identity. We keep insertion
  // order so the final bundle is deterministic (handy for caching).
  const cssChunks = new Map<string, string>(); // hash → content
  const jsChunks = new Map<string, string>();
  for (const f of htmlFiles) {
    const html = await fs.promises.readFile(f, 'utf-8');
    for (const m of html.matchAll(STYLE_RE)) {
      const content = m[1];
      if (!content.trim()) continue;
      cssChunks.set(hashChunk(content), content);
    }
    for (const m of html.matchAll(SCRIPT_RE)) {
      const content = m[1];
      if (!content.trim()) continue;
      jsChunks.set(hashChunk(content), content);
    }
  }

  let cssUrl: string | undefined;
  let jsUrl: string | undefined;
  let cssBytesSaved = 0;
  let jsBytesSaved = 0;

  // Write the unified CSS bundle. The hash is over the concatenated
  // content so a content change → new filename → cache busts cleanly.
  if (cssChunks.size > 0) {
    const concat = [...cssChunks.values()].join('\n\n');
    const hash = hashChunk(concat).slice(0, 10);
    const fileName = `blocks-${hash}.css`;
    const assetsDir = path.join(buildDir, '_assets');
    await fs.promises.mkdir(assetsDir, { recursive: true });
    await fs.promises.writeFile(path.join(assetsDir, fileName), concat);
    cssUrl = `/_assets/${fileName}`;
  }
  if (jsChunks.size > 0) {
    const concat = [...jsChunks.values()].join('\n\n');
    const hash = hashChunk(concat).slice(0, 10);
    const fileName = `blocks-${hash}.js`;
    const assetsDir = path.join(buildDir, '_assets');
    await fs.promises.mkdir(assetsDir, { recursive: true });
    await fs.promises.writeFile(path.join(assetsDir, fileName), concat);
    jsUrl = `/_assets/${fileName}`;
  }

  // Second pass: rewrite HTML files. Replace the first inline tag with
  // the shared reference and drop every other matching tag from that
  // file. Files that had no matching tags are skipped (no rewrite).
  let filesRewritten = 0;
  for (const f of htmlFiles) {
    let html = await fs.promises.readFile(f, 'utf-8');
    let mutated = false;

    if (cssUrl && STYLE_RE.test(html)) {
      STYLE_RE.lastIndex = 0;
      let injected = false;
      const replaced = html.replace(STYLE_RE, (match, content: string) => {
        cssBytesSaved += match.length - content.length; // approx: keep CSS, drop wrapper
        if (!injected) {
          injected = true;
          return `<link rel="stylesheet" href="${cssUrl}" data-blocks="1" />`;
        }
        return '';
      });
      if (replaced !== html) {
        html = replaced;
        mutated = true;
      }
    }

    if (jsUrl && SCRIPT_RE.test(html)) {
      SCRIPT_RE.lastIndex = 0;
      let injected = false;
      const replaced = html.replace(SCRIPT_RE, (match, content: string) => {
        jsBytesSaved += match.length - content.length;
        if (!injected) {
          injected = true;
          return `<script src="${jsUrl}" defer data-blocks="1"></script>`;
        }
        return '';
      });
      if (replaced !== html) {
        html = replaced;
        mutated = true;
      }
    }

    if (mutated) {
      await fs.promises.writeFile(f, html);
      filesRewritten++;
    }
  }

  return {
    css_url: cssUrl,
    js_url: jsUrl,
    files_rewritten: filesRewritten,
    css_bytes_saved: cssBytesSaved,
    js_bytes_saved: jsBytesSaved,
  };
}

async function listHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip the assets dir itself — no HTML there, and we don't want
        // to walk the bundle we just wrote.
        if (e.name === '_assets' || e.name === '_astro') continue;
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function hashChunk(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
