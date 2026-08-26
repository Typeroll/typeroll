// Post-build pass that pulls inlined block CSS/JS out of the rendered
// HTML, dedupes, writes a hashed bundle, and rewrites pages to link to
// it. Pure file I/O — tested against a tmp dir.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleBlockAssets } from '../../lib/deploy/bundle-blocks';

async function makeBuildDir(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tr-bundle-test-'));
  return root;
}

async function writeHtml(buildDir: string, rel: string, content: string): Promise<void> {
  const full = path.join(buildDir, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, content);
}

async function readHtml(buildDir: string, rel: string): Promise<string> {
  return fs.promises.readFile(path.join(buildDir, rel), 'utf-8');
}

describe('bundleBlockAssets', () => {
  let buildDir: string;
  beforeEach(async () => { buildDir = await makeBuildDir(); });

  it('writes a hashed bundle and rewrites a single HTML file', async () => {
    await writeHtml(buildDir, 'index.html',
      `<html><head><style data-blocks="1">.hero{color:red}</style></head><body>x</body></html>`,
    );
    const result = await bundleBlockAssets(buildDir);
    expect(result.css_url).toMatch(/^\/_assets\/blocks-[0-9a-f]{10}\.css$/);
    expect(result.files_rewritten).toBe(1);

    const html = await readHtml(buildDir, 'index.html');
    expect(html).not.toMatch(/<style data-blocks="1">/);
    expect(html).toContain(`<link rel="stylesheet" href="${result.css_url}"`);

    const cssFile = path.join(buildDir, result.css_url!);
    const cssContent = await fs.promises.readFile(cssFile, 'utf-8');
    expect(cssContent).toContain('.hero{color:red}');
  });

  it('deduplicates identical chunks across pages — single bundle URL', async () => {
    const css = '<style data-blocks="1">.btn{padding:1rem}</style>';
    await writeHtml(buildDir, 'a/index.html', `<head>${css}</head>`);
    await writeHtml(buildDir, 'b/index.html', `<head>${css}</head>`);
    await writeHtml(buildDir, 'c/index.html', `<head>${css}</head>`);

    const result = await bundleBlockAssets(buildDir);
    expect(result.files_rewritten).toBe(3);

    // The bundle contains the CSS only once (dedupe happened).
    const cssContent = await fs.promises.readFile(path.join(buildDir, result.css_url!), 'utf-8');
    const occurrences = (cssContent.match(/\.btn\{padding:1rem\}/g) ?? []).length;
    expect(occurrences).toBe(1);

    // All three HTML files reference the same URL.
    const a = await readHtml(buildDir, 'a/index.html');
    const b = await readHtml(buildDir, 'b/index.html');
    expect(a).toContain(result.css_url);
    expect(b).toContain(result.css_url);
  });

  it('unions distinct chunks (different pages with different blocks)', async () => {
    await writeHtml(buildDir, 'a.html',
      `<style data-blocks="1">.hero{color:red}</style>`);
    await writeHtml(buildDir, 'b.html',
      `<style data-blocks="1">.cta{color:blue}</style>`);

    const result = await bundleBlockAssets(buildDir);
    const cssContent = await fs.promises.readFile(path.join(buildDir, result.css_url!), 'utf-8');
    expect(cssContent).toContain('.hero');
    expect(cssContent).toContain('.cta');

    // Both pages now link to the bundle, neither carries inline.
    expect(await readHtml(buildDir, 'a.html')).not.toContain('<style data-blocks="1">');
    expect(await readHtml(buildDir, 'b.html')).not.toContain('<style data-blocks="1">');
  });

  it('keeps multiple inline tags from one page collapsed to a single link', async () => {
    // A page rendered through Astro can theoretically have multiple
    // data-blocks="1" tags if templates compose unexpectedly. Verify
    // we only inject ONE <link> per file.
    await writeHtml(buildDir, 'x.html',
      `<style data-blocks="1">.a{color:red}</style>` +
      `<style data-blocks="1">.b{color:blue}</style>`,
    );
    const result = await bundleBlockAssets(buildDir);
    const html = await readHtml(buildDir, 'x.html');
    const linkCount = (html.match(/<link[^>]+data-blocks="1"/g) ?? []).length;
    expect(linkCount).toBe(1);
    expect(html).not.toContain('<style data-blocks="1">');
    // But the bundle has both CSS chunks
    const cssContent = await fs.promises.readFile(path.join(buildDir, result.css_url!), 'utf-8');
    expect(cssContent).toContain('.a{color:red}');
    expect(cssContent).toContain('.b{color:blue}');
  });

  it('handles JS the same way (script src + defer)', async () => {
    await writeHtml(buildDir, 'a.html',
      `<script data-blocks="1">window.X = 1;</script>`,
    );
    const result = await bundleBlockAssets(buildDir);
    expect(result.js_url).toMatch(/^\/_assets\/blocks-[0-9a-f]{10}\.js$/);
    const html = await readHtml(buildDir, 'a.html');
    expect(html).toContain(`<script src="${result.js_url}" defer data-blocks="1">`);
    expect(html).not.toContain('<script data-blocks="1">');
  });

  it('skips HTML files with no block tags (no rewrite, no false positives)', async () => {
    await writeHtml(buildDir, 'plain.html', '<html><body>just text</body></html>');
    const result = await bundleBlockAssets(buildDir);
    expect(result.files_rewritten).toBe(0);
    expect(result.css_url).toBeUndefined();
  });

  it('does not walk _assets / _astro subdirectories', async () => {
    await writeHtml(buildDir, '_assets/old.html', '<style data-blocks="1">.old{}</style>');
    await writeHtml(buildDir, '_astro/foo.html', '<style data-blocks="1">.astro{}</style>');
    await writeHtml(buildDir, 'real.html', '<style data-blocks="1">.real{color:black}</style>');
    const result = await bundleBlockAssets(buildDir);
    expect(result.files_rewritten).toBe(1);
    const cssContent = await fs.promises.readFile(path.join(buildDir, result.css_url!), 'utf-8');
    expect(cssContent).toContain('.real');
    expect(cssContent).not.toContain('.old');
    expect(cssContent).not.toContain('.astro');
  });

  it('hash is content-stable: same CSS → same filename', async () => {
    const dir1 = await makeBuildDir();
    const dir2 = await makeBuildDir();
    await writeHtml(dir1, 'a.html', '<style data-blocks="1">.x{color:red}</style>');
    await writeHtml(dir2, 'b.html', '<style data-blocks="1">.x{color:red}</style>');
    const r1 = await bundleBlockAssets(dir1);
    const r2 = await bundleBlockAssets(dir2);
    expect(r1.css_url).toBe(r2.css_url);
  });
});
