import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import path from 'node:path';

function trailingSlashPolicy() {
  const root = process.env.TYPEROLL_FIXTURES_DIR;
  if (!root) return 'always';
  const org = process.env.TYPEROLL_ORG_ID || 'default';
  const site = process.env.TYPEROLL_SITE_ID || 'default';
  const version = process.env.TYPEROLL_VERSION_ID || 'main';
  const file = path.join(root, 'organizations', org, 'sites', site, 'versions', version, 'settings', 'default.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).trailing_slash;
    return value === 'never' || value === 'ignore' ? value : 'always';
  } catch {
    return 'always';
  }
}

// Static site generation. One build per customer site.
// Site config (URL, etc.) is injected via env vars at build time:
//   TYPEROLL_ORG_ID, TYPEROLL_SITE_ID, TYPEROLL_SITE_URL

export default defineConfig({
  site: process.env.TYPEROLL_SITE_URL || 'https://example.com',
  output: 'static',
  build: {
    assets: 'assets',
    // Inline ALL of Astro's component CSS (reset.css + global.css ≈ 7.4 KiB
    // raw / ~2 KiB gzip) into each page's <head> instead of a separate
    // /assets/*.css. `'auto'` left it external because the raw size exceeds
    // Vite's 4 KiB assetsInlineLimit — making it a render-blocking request
    // chained AFTER the HTML (PageSpeed "avoid chaining critical requests",
    // ~237 ms to LCP). Inlining removes that round-trip. Safe w.r.t. the
    // block-asset bundler: it only extracts `<style data-blocks="1">`, never
    // Astro's plain inlined CSS.
    inlineStylesheets: 'always',
  },
  // Resolve the site's canonical URL policy before Astro creates routes.
  // Sitemaps and renderer-generated links read the same setting.
  trailingSlash: trailingSlashPolicy(),
  compressHTML: true,
});
