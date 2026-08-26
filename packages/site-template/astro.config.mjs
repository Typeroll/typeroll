import { defineConfig } from 'astro/config';

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
  // Always emit URLs with trailing slash so sitemap, canonical, internal
  // links, and the static file layout all agree. Mixed behaviour was the
  // autopilot.se field report — sitemap had no slash, canonical did.
  trailingSlash: 'always',
  compressHTML: true,
});
