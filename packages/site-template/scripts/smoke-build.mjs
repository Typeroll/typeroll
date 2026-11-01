#!/usr/bin/env node
// Smoke-test for the site-template's astro build. Runs the same build
// the deploy pipeline runs but against the in-repo `fixtures/` tree —
// which is set up to exercise the broad surface of customer inputs:
//   - HTML-mode page (with <x-include> references and inline <style>)
//   - blocks-mode page (with nested section/columns/prose blocks)
//   - a collection that has route_template AND items (so per-item static
//     pages are generated — this is the path that caught the
//     pageForItem ReferenceError reported by the Sundsvallsflytt build)
//   - header + footer + free-block partials
//   - redirects collection
//
// CI runs this on every PR to site-template. A failure means the
// renderer regressed for at least one customer-input shape.
//
// Exit codes:
//   0 = clean build, every expected route produced an HTML file
//   1 = astro exited non-zero OR expected outputs are missing

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TEMPLATE_DIR = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(TEMPLATE_DIR, 'fixtures');

// Routes the bundled fixtures should produce after build. Update this
// list when you add a fixture page/collection/redirect.
const EXPECTED_HTML_ROUTES = [
  'index.html',                           // home page (slug='home')
  'about/index.html',                     // about page
  'blog/hello-from-smoke-test/index.html', // collection item — exercises pageForItem
  'showcase/index.html',                  // block-mode — Tier 1 + repeater alias + context
  'llms.txt',                             // AEO site map for AI assistants
];

function log(msg) { console.log(`[smoke] ${msg}`); }
function fail(msg) { console.error(`[smoke] ${msg}`); process.exit(1); }

function build(label, extraEnv, verifyOutput) {
  const outDir = mkdtempSync(join(tmpdir(), 'tr-smoke-'));
  process.on('exit', () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  log(`[${label}] building into ${outDir}`);
  log(`[${label}] using fixtures from ${FIXTURES_DIR}`);

  return new Promise((resolveBuild) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', outDir], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: FIXTURES_DIR,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
        ...extraEnv,
      },
    });

    child.on('exit', (code) => {
      if (code !== 0) fail(`[${label}] astro build exited with ${code}`);
      log(`[${label}] build succeeded — checking expected routes…`);
      const missing = [];
      for (const route of EXPECTED_HTML_ROUTES) {
        const fullPath = join(outDir, route);
        if (!existsSync(fullPath)) {
          missing.push(route);
          log(`  ✗ missing: ${route}`);
        } else {
          log(`  ✓ ${route}`);
        }
      }
      if (missing.length > 0) {
        fail(`[${label}] ${missing.length} expected route(s) missing — see list above`);
      }
      verifyOutput?.(outDir);
      log(`[${label}] OK — built ${EXPECTED_HTML_ROUTES.length} routes`);
      resolveBuild();
    });
  });
}

// Scenario 1: the normal deploy shape — fixtures dir set, no service account.
// Also pins the AI-agent outputs: llms.txt groups, llms-full.txt, a Markdown
// file per indexable page announced from its head, and an unchanged robots.txt
// and sitemap for a site without an AI crawler policy or hreflang.
await build('fixtures', {}, (outDir) => {
  const llms = readFileSync(join(outDir, 'llms.txt'), 'utf8');
  if (!/^## Pages$/m.test(llms) || !llms.includes('(https://smoke.test/llms-full.txt)') || !llms.includes('(https://smoke.test/sitemap.xml)')) fail('[agent-outputs] llms.txt lacks its groups or links');
  if (!llms.includes('](https://smoke.test/about/)')) fail('[agent-outputs] llms.txt does not list /about/');
  const full = readFileSync(join(outDir, 'llms-full.txt'), 'utf8');
  for (const route of ['index.md', 'about/index.md']) {
    if (!existsSync(join(outDir, route))) fail(`[agent-outputs] missing ${route}`);
  }
  const about = readFileSync(join(outDir, 'about', 'index.md'), 'utf8');
  if (!about.startsWith('# ') || !about.includes('URL: https://smoke.test/about/')) fail('[agent-outputs] about/index.md has no title or URL');
  if (!full.includes(about.split('\n')[0])) fail('[agent-outputs] llms-full.txt lacks the about page');
  const aboutHtml = readFileSync(join(outDir, 'about', 'index.html'), 'utf8');
  if (!aboutHtml.includes('<link rel="alternate" type="text/markdown" href="https://smoke.test/about/index.md">')) fail('[agent-outputs] about page does not announce its Markdown file');
  const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');
  if (/Content-Signal|GPTBot/i.test(robots)) fail('[agent-outputs] robots.txt changed without an AI crawler policy');
  const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
  if (!sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>')) fail('[agent-outputs] sitemap.xml header changed for a site without hreflang');
  log('[agent-outputs] ✓ llms.txt, llms-full.txt, Markdown pages, unchanged robots.txt and sitemap');
});

// Scenario 2 (regression): a deploy build runs on Cloud Run where
// FIREBASE_SERVICE_ACCOUNT is present in the environment and leaks into the
// build's env. The materialised fixtures snapshot — pointed at by
// TYPEROLL_FIXTURES_DIR — must still win, because it is the only copy with
// branch inheritance (settings, collections, block types) resolved. If the
// store instead selected Firestore from the (here bogus) service account, it
// would read version docs raw with no chain-fallback and a branch deploy would
// render defaults — the bug this pins. A bogus SA also can't reach Firestore,
// so picking it would fail the build outright; fixtures winning keeps it green.
await build('fixtures-win-over-sa', {
  FIREBASE_SERVICE_ACCOUNT: '{"project_id":"smoke-bogus","client_email":"x@x","private_key":"-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n"}',
});

// Scenario 3: a site-wide noindex setting must affect every static HTML page,
// not only the DB-live preview renderer.
await (async function sitewideNoindexScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-noindex-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
  const settingsPath = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'settings', 'default.json',
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.sitewide_noindex = true;
  writeFileSync(settingsPath, JSON.stringify(settings));
  await build(
    'sitewide-noindex',
    { TYPEROLL_FIXTURES_DIR: tmpFixtures },
    (outDir) => {
      for (const route of ['index.html', 'about/index.html']) {
        const html = readFileSync(join(outDir, route), 'utf8');
        if (!/<meta name="robots" content="noindex,follow"\s*\/?\s*>/.test(html)) {
          fail(`[sitewide-noindex] ${route} is missing the site-wide noindex meta directive`);
        }
      }
      if (existsSync(join(outDir, 'index.md')) || existsSync(join(outDir, 'about', 'index.md'))) fail('[sitewide-noindex] Markdown pages were published for a noindex site');
      if (/^## /m.test(readFileSync(join(outDir, 'llms.txt'), 'utf8'))) fail('[sitewide-noindex] llms.txt lists pages of a noindex site');
      if (readFileSync(join(outDir, 'index.html'), 'utf8').includes('type="text/markdown"')) fail('[sitewide-noindex] noindex page announces a Markdown file');
    },
  );
})();

// Scenario 4 (apps): the analytics app, when enabled for a site, injects a
// Cloudflare Web Analytics beacon into every page. We DON'T enable it in the
// committed fixtures (keeps the OSS sample clean) — instead copy the fixtures
// to a temp tree, drop in an enabled apps doc, build, and assert the beacon +
// its token appear in the output. This pins the getAppsPublic → BaseLayout
// injection path.
//
// The cookie banner is ON here: Cloudflare Web Analytics is cookieless, so the
// beacon must load directly — never held inert by the consent gate the way
// cookie-setting integration tags are — and carry only its token (no options
// that would add storage or change what it collects).
await (async function analyticsBeaconScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
  const TOKEN = 'SMOKE0BEACON0TOKEN';
  const appsDir = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'apps');
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(
    join(appsDir, 'default.json'),
    JSON.stringify({ apps: { analytics: { enabled: true, config: { beacon_token: TOKEN } } } }),
  );
  const settingsPath = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'settings', 'default.json',
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.cookie_consent = { enabled: true, text: 'We use cookies.' };
  writeFileSync(settingsPath, JSON.stringify(settings));

  log('[apps-analytics-beacon] building with the analytics app enabled…');
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[apps-analytics-beacon] astro build exited with ${code}`);
      const html = readFileSync(join(tmpOut, 'index.html'), 'utf8');
      if (!html.includes('static.cloudflareinsights.com/beacon.min.js')) {
        fail('[apps-analytics-beacon] beacon script missing from output');
      }
      if (!html.includes(TOKEN)) {
        fail('[apps-analytics-beacon] beacon token missing from output');
      }
      if (!html.includes('tr-consent-needed')) {
        fail('[apps-analytics-beacon] cookie banner missing, so independence from it was not exercised');
      }
      const tags = html.match(/<script\b[^>]*static\.cloudflareinsights\.com\/beacon\.min\.js[^>]*>/g) ?? [];
      if (tags.length !== 1) fail(`[apps-analytics-beacon] expected one beacon script tag, found ${tags.length}`);
      const tag = tags[0] ?? '';
      if (/\btype=/.test(tag) || /data-tr-consent/.test(tag) ||
          !/\bsrc="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"/.test(tag)) {
        fail(`[apps-analytics-beacon] beacon must load directly, independent of the cookie banner: ${tag}`);
      }
      const config = (/data-cf-beacon="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&quot;|&#34;/g, '"');
      let parsed = null;
      try { parsed = JSON.parse(config); } catch { /* reported below */ }
      if (!parsed || JSON.stringify(Object.keys(parsed)) !== '["token"]' || parsed.token !== TOKEN) {
        fail(`[apps-analytics-beacon] beacon configuration must carry only its token: ${config}`);
      }
      log('[apps-analytics-beacon] ✓ beacon injected with token, independent of the cookie banner');
      res();
    });
  });
})();

// Scenario 5 (integrations app): tags are built from validated IDs and routed
// through the platform's existing consent gate. Asserts three things the
// implementation could plausibly get wrong: a valid ID reaches the page; an
// INVALID one is dropped rather than interpolated into a <script> body; and a
// consent-category tag is emitted inert (type="text/plain") when the site has
// its cookie banner on, rather than firing before the visitor answers.
await (async function integrationsScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-int-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-int-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });

  const GOOD = 'G-SMOKE12345';
  const appsDir = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'apps');
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(join(appsDir, 'default.json'), JSON.stringify({
    apps: {
      integrations: {
        enabled: true,
        config: {
          google_analytics__measurement_id: GOOD,
          // Fails the GTM pattern — must never reach the output.
          google_tag_manager__container_id: "GTM-X'; fetch('//evil.test'); //",
        },
      },
    },
  }));

  // Turn the cookie banner on so the consent gate is exercised.
  const settingsPath = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'settings', 'default.json',
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.cookie_consent = { enabled: true, text: 'We use cookies.' };
  writeFileSync(settingsPath, JSON.stringify(settings));

  log('[apps-integrations] building with the integrations app enabled…');
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[apps-integrations] astro build exited with ${code}`);
      const html = readFileSync(join(tmpOut, 'index.html'), 'utf8');
      if (!html.includes(GOOD)) fail('[apps-integrations] valid GA4 id missing from output');
      if (html.includes('evil.test')) fail('[apps-integrations] INVALID id was interpolated into the page');
      if (html.includes('googletagmanager.com/gtm.js')) fail('[apps-integrations] GTM emitted despite an invalid id');
      // Held for consent: the gtag loader must be inert, not live.
      if (!/type="text\/plain"[^>]*data-tr-consent/.test(html) &&
          !/data-tr-consent[^>]*type="text\/plain"/.test(html)) {
        fail('[apps-integrations] consent-category tag was not held by the consent gate');
      }
      log('[apps-integrations] ✓ valid id emitted, invalid id dropped, consent gate applied');
      res();
    });
  });
})();

// Scenario 6 (Extension directives in HTML partials): preview and static
// generation must expand the same authoring reference. This deliberately
// puts one instance in each HTML-mode partial and none in the page body, so a
// body-only expansion cannot make the assertion pass accidentally.
await (async function extensionPartialScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-extension-partials-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-extension-partials-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });

  const base = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'versions', 'main');
  const blockTypeId = 'extension--inst-smoke--lead-form';
  const blockTypesDir = join(base, 'block_types');
  mkdirSync(blockTypesDir, { recursive: true });
  writeFileSync(join(blockTypesDir, `${blockTypeId}.json`), JSON.stringify({
    id: blockTypeId,
    name: 'lead-form',
    label: 'Lead form',
    category: 'extension',
    origin: 'extension',
    schema: [],
    template: '',
    extension: {
      extension_id: 'se.example.market-engine',
      installation_id: 'inst-smoke',
      component_id: 'lead-form',
    },
  }));
  writeFileSync(join(base, 'partials', 'header.json'), JSON.stringify({
    id: 'header', kind: 'header', status: 'published', content_mode: 'html',
    html_content: `<header id="extension-header"><x-extension block="${blockTypeId}" props='{&quot;mode&quot;:&quot;banner&quot;}' /></header>`,
  }));
  writeFileSync(join(base, 'partials', 'footer.json'), JSON.stringify({
    id: 'footer', kind: 'footer', status: 'published', content_mode: 'html',
    html_content: `<footer id="extension-footer"><x-extension block="${blockTypeId}" props='{&quot;mode&quot;:&quot;banner&quot;}' /></footer>`,
  }));

  log('[extension-html-partials] building with Extension directives in header + footer…');
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[extension-html-partials] astro build exited with ${code}`);
      const html = readFileSync(join(tmpOut, 'index.html'), 'utf8');
      if (html.includes('<x-extension')) {
        fail('[extension-html-partials] raw Extension directive reached the static output');
      }
      if ((html.match(/class="tr-extension-mount"/g) ?? []).length !== 2) {
        fail('[extension-html-partials] expected one Extension mount in each partial');
      }
      if (!html.includes('id="extension-header"') || !html.includes('id="extension-footer"')) {
        fail('[extension-html-partials] header or footer wrapper missing from output');
      }
      const notFound = readFileSync(join(tmpOut, '404.html'), 'utf8');
      if (notFound.includes('<x-extension')
          || (notFound.match(/class="tr-extension-mount"/g) ?? []).length !== 2) {
        fail('[extension-html-partials] 404 output did not expand both partial directives');
      }
      log('[extension-html-partials] ✓ header + footer directives expanded into mounts');
      res();
    });
  });
})();

// Scenario 7 (renderer additions): taxonomy routes, core/embed's per-instance
// JS, and reference-backed listings have unit tests, but none of them had ever
// been through a REAL astro build — where getStaticPaths, the asset bundler
// and the sanitizer all actually run. Route generation in particular can only
// fail here.
await (async function directoryRendererScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-dir-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-dir-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });

  const base = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'versions', 'main');
  const collDir = join(base, 'content_types');
  mkdirSync(collDir, { recursive: true });

  // A listings collection with two facets. `city` has one value with two
  // items (a page) and one with a single item (below min_items, no page) —
  // so the run proves the guard fires rather than just that routes appear.
  writeFileSync(join(collDir, 'companies.json'), JSON.stringify({
    name: 'companies', label_singular: 'Company', label_plural: 'Companies',
    fields: [
      { name: 'city', label: 'City', type: 'text' },
    ],
    facets: [{ field: 'city', base_path: '/ort', label_singular: 'Ort' }],
    route_template: '/foretag/{slug}',
  }));
  // Items live under `collections/{name}/items/`, matching paths.collectionItems.
  const itemsDir = join(base, 'pages');
  mkdirSync(itemsDir, { recursive: true });
  const company = (id, title, city) => writeFileSync(
    join(itemsDir, `${id}.json`),
    JSON.stringify({ content_type: 'companies', content_mode: 'blocks', blocks: [], status: 'published', title, slug: id, fields: { city } }),
  );
  company('acme', 'Acme', 'Göteborg');
  company('beta', 'Beta', 'Göteborg');
  company('gamma', 'Gamma', 'Malmö');   // alone → must NOT get a page
  // Two cities that BOTH clear min_items, so the build renders more than one
  // facet page. Content.ts memoizes collection queries across routes for the
  // whole build; a cache keyed too loosely would serve Gothenburg's item set
  // on Uppsala's page, and with only one facet page nothing would notice.
  company('delta', 'Delta', 'Uppsala');
  company('epsilon', 'Epsilon', 'Uppsala');

  // A page carrying core/embed, to prove the per-instance script survives the
  // sanitizer (it must NOT be in the body) and reaches the bundle.
  writeFileSync(join(base, 'pages', 'embed-smoke.json'), JSON.stringify({
    title: 'Embed smoke', slug: 'embed-smoke', status: 'published',
    content_mode: 'blocks',
    blocks: [{
      id: 'blk_smoke', type: 'core/embed',
      data: { html: '<p id="embed-target">markup</p>', js: 'el.dataset.smoke = "ran"' },
    }],
  }));

  // A page declaring an hreflang cluster. The renderer must inject the
  // page's own self-reference and DROP the malformed entry rather than
  // escape it into the attribute — the head is the one place where a bad
  // value is both an SEO liability and an injection surface.
  writeFileSync(join(base, 'pages', 'hreflang-smoke.json'), JSON.stringify({
    title: 'Hreflang smoke', slug: 'hreflang-smoke', status: 'published',
    content_mode: 'html', html_content: '<p>hej</p>', language: 'sv',
    alternates: [
      { hreflang: 'de', href: 'https://example.de/ueber-uns' },
      { hreflang: 'en" onload="alert(1)', href: 'https://evil.test/' },
    ],
  }));

  // A site-authored BlockType placed in the HEADER partial. Partials used to
  // render against the core library alone, so this rendered as nothing on the
  // live site while the portal preview (merged registry) showed it working —
  // and their CSS/JS was never collected, since assets came from the page body
  // only. Header blocks appear on every page, so the assertions below run
  // against an ordinary page.
  const blockTypesDir = join(base, 'block_types');
  mkdirSync(blockTypesDir, { recursive: true });
  writeFileSync(join(blockTypesDir, 'user--headline-badge.json'), JSON.stringify({
    id: 'user/headline_badge',
    name: 'headline_badge',
    label: 'Headline badge',
    category: 'content',
    origin: 'user',
    schema: [{ name: 'text', type: 'text', label: 'Text' }],
    template: '<span class="hdr-badge" data-badge>{{text}}</span>',
    styles: '.hdr-badge { color: rebeccapurple; }',
    script: 'el.setAttribute("data-badge-ran", "1");',
  }));
  // A second type whose TEMPLATE binds site context, to prove the render
  // context now reaches partials — without it {{site.name}} rendered empty on
  // the live site while the portal preview (which passes context) showed it.
  writeFileSync(join(blockTypesDir, 'user--site-stamp.json'), JSON.stringify({
    id: 'user/site_stamp',
    name: 'site_stamp',
    label: 'Site stamp',
    category: 'content',
    origin: 'user',
    schema: [],
    // Both spellings: `site_name` is the raw settings field, `name` is the
    // alias siteContext() adds because that is what the core template blocks
    // bind. Asserting both keeps the alias from being "fixed" by renaming.
    template: '<span class="hdr-stamp">STAMP:{{site.site_name}}|ALIAS:{{site.name}}</span>',
  }));
  writeFileSync(join(base, 'partials', 'header.json'), JSON.stringify({
    kind: 'header', status: 'published', content_mode: 'blocks',
    blocks: [
      { id: 'blk_badge', type: 'user/headline_badge', data: { text: 'CUSTOM-HEADER-BLOCK' } },
      { id: 'blk_stamp', type: 'user/site_stamp', data: {} },
    ],
  }));

  // A listing in the FOOTER with no filter of its own. It inherits the facet
  // scope from the render context, so it renders DIFFERENT items on
  // /ort/goteborg/ than on /ort/uppsala/ — while containing no {{facet.*}}
  // token anywhere. That is the case a token-only cache check would miss, and
  // it is why renderPartialHtml also inspects block TYPES.
  writeFileSync(join(base, 'partials', 'footer.json'), JSON.stringify({
    kind: 'footer', status: 'published', content_mode: 'blocks',
    blocks: [{
      id: 'blk_foot_list', type: 'core/page_list',
      data: { content_type: 'companies', sort_by: 'title', sort_order: 'asc', limit: 20 },
    }],
  }));

  log('[directory-renderer] building with facets + core/embed…');
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[directory-renderer] astro build exited with ${code}`);

      // Taxonomy: the two-item city is a page, the one-item city is not.
      if (!existsSync(join(tmpOut, 'ort', 'goteborg', 'index.html'))) {
        fail('[directory-renderer] taxonomy page for the 2-item facet value was not built');
      }
      if (existsSync(join(tmpOut, 'ort', 'malmo', 'index.html'))) {
        fail('[directory-renderer] min_items guard failed — a 1-item facet value got a page');
      }
      // …and it actually lists its own items, i.e. the listing block inherited
      // the facet scope from the render context.
      const sitemap = readFileSync(join(tmpOut, 'sitemap.xml'), 'utf8');
      for (const path of ['/ort/goteborg/', '/ort/uppsala/', '/foretag/acme/']) {
        if (!sitemap.includes(`https://smoke.test${path}</loc>`)) fail(`[directory-renderer] built route missing from sitemap: ${path}`);
      }
      if (sitemap.includes('/ort/malmo/')) fail('[directory-renderer] sitemap advertises an unbuilt facet');
      const facetHtml = readFileSync(join(tmpOut, 'ort', 'goteborg', 'index.html'), 'utf8');
      if (!facetHtml.includes('Acme') || !facetHtml.includes('Beta')) {
        fail('[directory-renderer] facet page did not inherit its scope — items missing');
      }
      if (facetHtml.includes('Gamma')) {
        fail('[directory-renderer] facet page leaked an item from another facet value');
      }
      // The SECOND facet page, checked independently. Collection queries are
      // memoized across routes for the whole build, so a cache keyed too
      // loosely would hand Gothenburg's resolved item set to Uppsala — and
      // asserting only one facet page would never catch it.
      const facetHtml2 = readFileSync(join(tmpOut, 'ort', 'uppsala', 'index.html'), 'utf8');
      if (!facetHtml2.includes('Delta') || !facetHtml2.includes('Epsilon')) {
        fail('[directory-renderer] second facet page is missing its own items');
      }
      if (facetHtml2.includes('Acme') || facetHtml2.includes('Beta')) {
        fail('[directory-renderer] facet page served another facet value\'s items — cache leak');
      }

      // core/embed: markup in the body, code OUT of it and in the bundle.
      const embedHtml = readFileSync(join(tmpOut, 'embed-smoke', 'index.html'), 'utf8');
      if (!embedHtml.includes('id="embed-target"')) {
        fail('[directory-renderer] core/embed markup missing from the page');
      }
      if (!embedHtml.includes('data-bid="blk_smoke"')) {
        fail('[directory-renderer] script-bearing instance did not get data-bid — its JS would no-op');
      }
      // The code may live in the inline bundle or an extracted asset,
      // depending on whether the block bundler kicked in — both are outside
      // the sanitized body, which is what matters.
      const bundled = embedHtml.includes('el.dataset.smoke')
        || readdirSync(join(tmpOut, '_assets'), { withFileTypes: true })
             .filter((e) => e.isFile() && e.name.endsWith('.js'))
             .some((e) => readFileSync(join(tmpOut, '_assets', e.name), 'utf8').includes('el.dataset.smoke'));
      if (!bundled) fail('[directory-renderer] core/embed JS never reached the output');

      // A site's own BlockType inside the header partial: markup, styles and
      // script all have to reach an ordinary page.
      const anyPage = readFileSync(join(tmpOut, 'about', 'index.html'), 'utf8');
      if (!anyPage.includes('CUSTOM-HEADER-BLOCK')) {
        fail('[directory-renderer] custom BlockType in the header partial did not render');
      }
      if (!anyPage.includes('rebeccapurple')) {
        fail('[directory-renderer] header partial block rendered without its CSS');
      }
      const headerJsBundled = anyPage.includes('data-badge-ran')
        || readdirSync(join(tmpOut, '_assets'), { withFileTypes: true })
             .filter((e) => e.isFile() && e.name.endsWith('.js'))
             .some((e) => readFileSync(join(tmpOut, '_assets', e.name), 'utf8').includes('data-badge-ran'));
      if (!headerJsBundled) {
        fail('[directory-renderer] header partial block rendered without its JS');
      }
      // Same on the 404 page, which builds its own shell rather than going
      // through [...slug].astro.
      const notFound = readFileSync(join(tmpOut, '404.html'), 'utf8');
      if (!notFound.includes('CUSTOM-HEADER-BLOCK') || !notFound.includes('rebeccapurple')) {
        fail('[directory-renderer] 404 page dropped the header partial block or its CSS');
      }

      // Render context reaches partials: a block template binding {{site.name}}
      // in the header resolves instead of rendering empty.
      if (!anyPage.includes('STAMP:ACME Studio')) {
        fail('[directory-renderer] partial did not receive the render context — {{site.site_name}} unresolved');
      }
      if (!notFound.includes('STAMP:ACME Studio')) {
        fail('[directory-renderer] 404 partial did not receive the render context');
      }
      // {{site.name}} is what template/site_title and template/site_logo bind.
      // SiteSettings has no `name` field, so this only resolves because the
      // context is built through siteContext().
      if (!anyPage.includes('ALIAS:ACME Studio')) {
        fail('[directory-renderer] {{site.name}} did not resolve — context not built via siteContext()');
      }
      // Collection source reaches partials: the footer listing resolves items
      // on an ordinary page, where no facet scope applies.
      if (!anyPage.includes('Acme') || !anyPage.includes('Delta')) {
        fail('[directory-renderer] footer listing in a partial resolved no items — pageSource missing');
      }

      // hreflang cluster reaches <head>, self-reference included, junk dropped.
      const hreflangPage = readFileSync(join(tmpOut, 'hreflang-smoke', 'index.html'), 'utf8');
      if (!hreflangPage.includes('hreflang="de"')) {
        fail('[directory-renderer] declared hreflang alternate missing from <head>');
      }
      if (!hreflangPage.includes('hreflang="sv"')) {
        fail('[directory-renderer] hreflang self-reference not injected — Google drops such clusters');
      }
      if (hreflangPage.includes('evil.test')) {
        fail('[directory-renderer] malformed hreflang entry reached the head');
      }
      // hreflang links only; the page's Markdown alternate is a separate link type.
      if ((hreflangPage.match(/rel="alternate" hreflang=/g) ?? []).length !== 2) {
        fail('[directory-renderer] expected exactly 2 hreflang alternate links (self + de)');
      }

      log('[directory-renderer] ✓ facets gated + scoped, core/embed JS bundled outside the body');
      log('[directory-renderer] ✓ custom BlockType in a partial renders with its CSS + JS');
      log('[directory-renderer] ✓ hreflang cluster emitted with self-reference, junk dropped');
      res();
    });
  });
})();

// Scenario 8 (URL policy): Astro's output layout and generated discovery
// documents must switch together. A unit test can prove URL formatting, but
// only a real build proves Astro read the materialized site setting before it
// generated route canonicals. Astro's default directory build format still
// stores the route as about/index.html for either URL policy.
await (async function noTrailingSlashScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-slash-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-slash-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
  const settingsPath = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'settings', 'default.json',
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.trailing_slash = 'never';
  writeFileSync(settingsPath, JSON.stringify(settings));

  log('[trailing-slash-never] building with extensionless canonical URLs…');
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[trailing-slash-never] astro build exited with ${code}`);
      const about = readFileSync(join(tmpOut, 'about', 'index.html'), 'utf8');
      if (!about.includes('<link rel="canonical" href="https://smoke.test/about"')) {
        fail('[trailing-slash-never] page canonical did not use /about');
      }
      if (about.includes('<link rel="canonical" href="https://smoke.test/about/"')) {
        fail('[trailing-slash-never] page canonical retained a trailing slash');
      }
      const sitemap = readFileSync(join(tmpOut, 'sitemap.xml'), 'utf8');
      if (!sitemap.includes('<loc>https://smoke.test/about</loc>')) {
        fail('[trailing-slash-never] sitemap did not emit the configured URL policy');
      }
      if (sitemap.includes('<loc>https://smoke.test/about/</loc>')) {
        fail('[trailing-slash-never] sitemap mixed trailing-slash policies');
      }
      log('[trailing-slash-never] ✓ canonical and sitemap use extensionless URLs');
      res();
    });
  });
})();

// Scenario 9 (native Page composition): exercise the complete M07
// contract through a real Astro build, not only the shared renderer. The
// fixture deliberately combines typed URL binding, SSR breadcrumbs/outline,
// selected item fields, explicit navigation, and nested instance CSS.
await (async function nativeCollectionCompositionScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-composition-'));
  const tmpOut = mkdtempSync(join(tmpdir(), 'tr-smoke-out-composition-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });

  const collectionDir = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'content_types',
  );
  mkdirSync(collectionDir, { recursive: true });
  const collection = {
    id: 'guides',
    name: 'guides',
    label_singular: 'Guide',
    label_plural: 'Guides',
    sort_field: 'sort_order',
    sort_dir: 'asc',
    route_template: '/guides/{slug}',
    facets: [{ field: 'category', base_path: '/category', label_singular: 'Category', min_items: 1 }],
    fields: [
      { name: 'pdf_url', label: 'PDF', type: 'url' },
      { name: 'prev_url', label: 'Previous URL', type: 'url' },
      { name: 'prev_title', label: 'Previous title', type: 'text' },
      { name: 'next_url', label: 'Next URL', type: 'url' },
      { name: 'next_title', label: 'Next title', type: 'text' },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'delivery', label: 'Delivery', type: 'boolean' },
      { name: 'cost', label: 'Cost', type: 'number' },
      { name: 'related', label: 'Related guide', type: 'page_ref' },
      { name: 'empty_policy', label: 'Empty policy', type: 'text' },
      { name: 'private_note', label: 'Private note', type: 'text', rendered: false },
    ],
    blocks: [
      { id: 'crumbs', type: 'template/page_breadcrumbs', data: { home_label: 'Home', aria_label: 'Breadcrumbs' } },
      { id: 'title', type: 'template/page_title', data: { level: 'h1', size: 'auto' } },
      { id: 'facts', type: 'core/field_list', data: { title: 'Guide facts', fields: ['category', 'delivery', 'cost', 'related', 'empty_policy', 'private_note'].map(field => ({ field, ...(field === 'delivery' ? { boolean_display: 'yes-no' } : {}) })) } },
      { id: 'empty-facts', type: 'core/field_list', data: { title: 'Empty facts heading', fields: [{ field: 'empty_policy' }, { field: 'private_note' }] } },
      {
        id: 'content',
        type: 'core/columns',
        data: { ratio: '3-1', gap: 'lg', align: 'start' },
        style_overrides: { custom_css: '.smoke-instance-css { overflow-wrap: anywhere; }' },
        slots: [
          [{ id: 'body', type: 'template_content_slot', data: { field: 'body', max_width: 'normal', font_size: 16, line_height: 1.6, paragraph_spacing: 0.75 } }],
          [{ id: 'outline', type: 'core/table_of_contents', data: { title: 'Contents', levels: 'h2-h3' } }],
        ],
      },
      {
        id: 'download-if', type: 'template/show_if', data: { condition: 'page.pdf_url' },
        children: [{ id: 'download', type: 'core/button', data: { label: 'Download', href: '{{page.pdf_url}}', variant: 'primary', size: 'md' } }],
      },
      {
        id: 'navigation', type: 'template/page_navigation',
        data: {
          previous_label: 'Previous', next_label: 'Next', aria_label: 'Guide navigation',
          previous_url_field: 'prev_url', previous_title_field: 'prev_title',
          next_url_field: 'next_url', next_title_field: 'next_title',
        },
      },
    ],
    created_at: '2026-09-05T00:00:00.000Z',
  };
  const { blocks, ...typeDefinition } = collection;
  writeFileSync(join(collectionDir, 'guides.json'), JSON.stringify({ ...typeDefinition, template: 'guide-layout' }));
  const templateDir = join(collectionDir, '..', 'page_templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'guide-layout.json'), JSON.stringify({ id: 'guide-layout', name: 'guide-layout', label: 'Guide', status: 'published', blocks }));
  const itemDir = join(collectionDir, '..', 'pages');
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, 'energy.json'), JSON.stringify({
    id: 'energy',
    title: 'A deliberately long energy guide title that must remain readable',
    slug: 'energy',
    content_type: 'guides', content_mode: 'blocks',
    blocks: [
      { id: 'prepare', type: 'core/rich_heading', data: { level: 'h1', html: 'Prepare &amp; plan', anchor_id: 'prepare' } },
      { id: 'body', type: 'core/prose', data: { html: '<p>Body</p>' } },
      { id: 'pack', type: 'core/heading', data: { level: 'h3', text: 'Pack safely' } },
    ],
    fields: {
    pdf_url: 'https://cdn.example.test/energy.pdf?download=1&lang=en',
    prev_url: '/guides/previous/',
    prev_title: 'Previous guide',
    next_url: '',
    next_title: '',
    category: 'Energy', delivery: false, cost: 0, related: 'first-guide', empty_policy: '', private_note: 'DO-NOT-PUBLISH',
    },
    sort_order: 2,
    status: 'published',
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  }));
  const pageDir = join(
    tmpFixtures, 'organizations', 'default', 'sites', 'default',
    'versions', 'main', 'pages',
  );
  writeFileSync(join(pageDir, 'responsive-archive.json'), JSON.stringify({
    id: 'responsive-archive',
    title: 'Responsive archive',
    slug: 'responsive-archive',
    path: '/responsive-archive/',
    content_mode: 'blocks',
    status: 'published',
    blocks: [{
      id: 'responsive-list',
      type: 'core/page_list',
      data: {
        content_type: 'guides',
        layout: 'grid',
        cols: { mobile: 1, tablet: 2, desktop: 3 },
        item_overrides: { show_image: false, title_field: 'title', href_field: 'url', heading_level: 'h2' },
      },
    }],
  }));

  writeFileSync(join(templateDir, 'alternate-guide.json'), JSON.stringify({ id: 'alternate-guide', name: 'alternate-guide', label: 'Alternate', status: 'published', blocks: [
    { id: 'marker', type: 'core/heading', data: { text: 'Alternate presentation', level: 'h1' } },
    { id: 'body', type: 'template_content_slot', data: {} },
  ] }));
  writeFileSync(join(itemDir, 'first-guide.json'), JSON.stringify({ id: 'first-guide', title: 'First by manual order', slug: 'first-guide', content_type: 'guides', sort_order: -10, template: 'alternate-guide', status: 'published', content_mode: 'blocks', fields: {}, blocks: [
    { id: 'body', type: 'core/prose', data: { html: '<p>Independent Page body</p>' } },
  ] }));
  log('[native-page-composition] building typed, SSR Page template…');
  const formsDir = join(tmpFixtures, 'organizations/default/sites/default/forms');
  mkdirSync(formsDir, { recursive: true });
  writeFileSync(join(formsDir, 'asset-form.json'), JSON.stringify({
    id: 'asset-form', name: 'Asset form', submit_url: 'https://forms.example.test/submit',
    steps: [{ id: 'intro', blocks: [{ id: 'gallery', type: 'core/gallery', data: {
      items: [{ src: '/example.svg', alt: 'Example' }],
    } }] }],
  }));
  writeFileSync(join(pageDir, 'guides.json'), JSON.stringify({
    id: 'guides', title: 'Guides', slug: 'guides', status: 'published', content_mode: 'html', html_content: '<h1>Guides</h1>',
  }));
  writeFileSync(join(pageDir, 'form-assets.json'), JSON.stringify({
    id: 'form-assets', title: 'Form assets', slug: 'form-assets', status: 'published',
    content_mode: 'html', html_content: '<h1>Form assets</h1><x-form id="asset-form" />',
  }));
  await new Promise((res) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', tmpOut], {
      cwd: TEMPLATE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        TYPEROLL_ORG_ID: 'default',
        TYPEROLL_SITE_ID: 'default',
        TYPEROLL_VERSION_ID: 'main',
        TYPEROLL_FIXTURES_DIR: tmpFixtures,
        TYPEROLL_SITE_URL: 'https://smoke.test',
        FIREBASE_SERVICE_ACCOUNT: '',
      },
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`[native-page-composition] astro build exited with ${code}`);
      const html = readFileSync(join(tmpOut, 'guides', 'energy', 'index.html'), 'utf8');
      if ((html.match(/<h1\b/g) ?? []).length !== 1 || !/<h2\b[^>]*id="prepare"/.test(html)) fail('[native-page-composition] template title must be the only H1 and legacy body title must become H2');
      const facts = html.match(/<section[^>]*data-block="field_list"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
      if ((facts.match(/<dt>/g) ?? []).length !== 4 || !facts.includes('<dd>No</dd>') || !facts.includes('<dd>0</dd>') || !facts.includes('href="/guides/first-guide/"')) fail('[native-page-composition] typed field list did not render four facts and its reference link');
      if (html.includes('Empty facts heading') || facts.includes('Empty policy') || facts.includes('Private note') || html.includes('DO-NOT-PUBLISH')) fail('[native-page-composition] empty/private field-list content leaked');
      for (const style of ['--page-body-font-size:16px', '--page-body-line-height:1.6', '--page-body-paragraph-spacing:0.75em']) {
        if (!html.includes(style)) fail(`[native-page-composition] missing template typography: ${style}`);
      }
      const assetText = existsSync(join(tmpOut, '_assets'))
        ? readdirSync(join(tmpOut, '_assets'), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
            .map((entry) => readFileSync(join(tmpOut, '_assets', entry.name), 'utf8'))
            .join('\n')
        : '';
      if (!html.includes('href="/guides/"') || !html.includes('href="/category/energy/"')) {
        fail('[native-page-composition] server breadcrumb trail is incomplete');
      }
      if (!html.includes('href="#prepare"') || !html.includes('href="#pack-safely"') || !html.includes('id="pack-safely"')) {
        fail('[native-page-composition] outline links and heading ids do not agree in initial HTML');
      }
      if (!html.includes('https://cdn.example.test/energy.pdf?download=1&amp;lang=en') || html.includes('{{item.pdf_url}}')) {
        fail('[native-page-composition] typed PDF binding leaked or resolved incorrectly');
      }
      if (!html.includes('href="/guides/previous/"')
          || !html.includes('class="page-navigation-next" data-empty="true"')) {
        fail('[native-page-composition] explicit neighbor fields or terminal empty state failed');
      }
      if (!(html + assetText).includes('.smoke-instance-css { overflow-wrap: anywhere; }')) {
        fail('[native-page-composition] nested instance CSS did not reach build assets');
      }
      const archive = readFileSync(join(tmpOut, 'responsive-archive', 'index.html'), 'utf8');
      // Only this page's inline assets count. Concatenating other routes'
      // bundles can conceal a missing dependency in this listing.
      if (!archive.includes('First by manual order') || archive.indexOf('First by manual order') > archive.indexOf('A deliberately long energy guide')) fail('[native-page-composition] listing did not inherit the type manual order');
      const alternative = readFileSync(join(tmpOut, 'guides/first-guide/index.html'), 'utf8');
      if (!alternative.includes('Alternate presentation') || !alternative.includes('Independent Page body')) fail('[native-page-composition] per-page template override did not preserve body');
      const archiveBundle = archive;
      if (!archiveBundle.includes('/* core/repeater */') || !archiveBundle.includes('/* core/post_card */')) {
        fail('[native-page-composition] listing alias omitted its repeater or item CSS');
      }
      const compactArchiveBundle = archiveBundle.replace(/\s+/g, '');
      if (!compactArchiveBundle.includes('--cols:1')
          || !compactArchiveBundle.includes('@media(min-width:640px){[data-bid="responsive-list"]{--cols:2!important;}}')
          || !compactArchiveBundle.includes('@media(min-width:1280px){[data-bid="responsive-list"]{--cols:3!important;}}')) {
        fail('[native-page-composition] responsive data fields did not survive the hosted build pipeline');
      }
      if (/<img\b[^>]*class="[^"]*block-postcard-image/.test(archive) || archive.includes('src=""')) {
        fail('[native-page-composition] hidden or empty post-card media left unused markup');
      }
      const formPage = readFileSync(join(tmpOut, 'form-assets/index.html'), 'utf8');
      if (!formPage.includes('/example.svg') || !formPage.includes('/* core/repeater */') || !formPage.includes('/* core/image */')) {
        fail('[native-page-composition] embedded form omitted its step block dependencies');
      }
      if (archive.includes('/* core/image */')) {
        fail('[native-page-composition] an unreferenced form leaked block assets into the listing');
      }
      log('[native-page-composition] ✓ typed bindings, SSR navigation, responsive fields, selected fields, and instance CSS');
      res();
    });
  });
})();

// Scenario: one site, two languages. Finnish is the site language at the root
// and Swedish is a language section under /sv/. Pages in the section get its
// header and footer variant (show_if on page.language), banner wording, home
// crumb and a 404 page at /sv/404.html that hosts serve for missing /sv/ paths.
await (async function languageSectionsScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-lang-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
  const version = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'versions', 'main');
  const settingsPath = join(version, 'settings', 'default.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.language = 'fi';
  settings.cookie_consent = { enabled: true, text: '<p>FI-BANNER</p>', privacy_policy_url: '/evasteet/' };
  settings.language_sections = [{
    language: 'sv-SE', home_path: '/sv/', tagline: 'SV-TAGLINE',
    cookie_consent: { text: '<p>SV-BANNER</p>', privacy_policy_url: '/sv/cookies/' },
  }, { language: 'ar', home_path: '/ar/' }];
  writeFileSync(settingsPath, JSON.stringify(settings));
  const html = (id, markup) => ({ id, type: 'core/html', data: { html: markup } });
  writeFileSync(join(version, 'partials', 'header.json'), JSON.stringify({
    name: 'Main header', kind: 'header', content_mode: 'blocks', status: 'published',
    blocks: [
      { id: 'logo', type: 'template/site_logo', data: { mode: 'text', height: 'md', link_to_home: true } },
      { id: 'sv-menu', type: 'template/show_if', data: { condition: 'page.language === "sv-SE"' }, children: [html('sv-menu-html', '<nav>SV-MENU</nav>')] },
      { id: 'fi-menu', type: 'template/show_if', data: { condition: 'page.language !== "sv-SE"' }, children: [html('fi-menu-html', '<nav>FI-MENU</nav>')] },
    ],
  }));
  const breadcrumbs = { id: 'crumbs', type: 'template/page_breadcrumbs', data: { home_label: 'Home', aria_label: 'Breadcrumbs' } };
  writeFileSync(join(version, 'pages', 'sv-home.json'), JSON.stringify({
    title: 'Svenska', slug: 'sv', path: '/sv', language: 'sv-SE', content_mode: 'blocks', status: 'published', content_type: 'page', fields: {},
    blocks: [html('sv-home-body', '<h1>Svenska</h1>')],
  }));
  writeFileSync(join(version, 'pages', 'sv-article.json'), JSON.stringify({
    title: 'Artikel', slug: 'artikel', path: '/sv/artikel', parent: 'sv-home', language: 'sv-SE', content_mode: 'blocks', status: 'published', content_type: 'page', fields: {},
    blocks: [breadcrumbs, html('sv-article-body', '<h1>Artikel</h1>')],
  }));

  // Arabic is written right to left: its pages get dir="rtl" and the mirror stylesheet.
  writeFileSync(join(version, 'pages', 'ar-home.json'), JSON.stringify({
    title: 'العربية', slug: 'ar', path: '/ar', language: 'ar', content_mode: 'blocks', status: 'published', content_type: 'page', fields: {},
    blocks: [html('ar-home-body', '<h1>العربية</h1>')],
  }));

  await build('language-sections', { TYPEROLL_FIXTURES_DIR: tmpFixtures }, (outDir) => {
    const sv = readFileSync(join(outDir, 'sv', 'artikel', 'index.html'), 'utf8');
    const fi = readFileSync(join(outDir, 'about', 'index.html'), 'utf8');
    if (!sv.includes('lang="sv-SE"')) fail('[language-sections] Swedish page lost its language');
    if (!sv.includes('SV-MENU') || sv.includes('FI-MENU')) fail('[language-sections] Swedish page did not get only the Swedish header');
    if (!fi.includes('FI-MENU') || fi.includes('SV-MENU')) fail('[language-sections] Finnish page did not get only the Finnish header');
    if (!sv.includes('SV-BANNER') || !sv.includes('href="/sv/cookies/"') || sv.includes('FI-BANNER')) fail('[language-sections] Swedish page did not get the Swedish banner');
    if (!fi.includes('FI-BANNER') || !fi.includes('href="/evasteet/"') || fi.includes('SV-BANNER')) fail('[language-sections] Finnish page did not get the Finnish banner');
    if (!sv.includes('<a href="/sv/">Startsida</a>')) fail('[language-sections] Swedish home crumb is not "Startsida" linking to /sv/');
    if (/<a href="\/sv\/?">Svenska<\/a>/.test(sv)) fail('[language-sections] section home page repeated as a crumb');
    const logoHref = (page) => page.match(/<a data-block="site-logo"[^>]* href="([^"]*)"/)?.[1];
    if (logoHref(sv) !== '/sv/' || logoHref(fi) !== '/') fail(`[language-sections] logo links to ${logoHref(sv)} on sv and ${logoHref(fi)} on fi`);
    if (!existsSync(join(outDir, 'sv', '404.html')) || existsSync(join(outDir, 'sv', '404'))) fail('[language-sections] section 404 page was not moved to sv/404.html');
    const notFound = readFileSync(join(outDir, 'sv', '404.html'), 'utf8');
    if (!notFound.includes('Sidan hittades inte') || !notFound.includes('href="/sv/"') || !notFound.includes('SV-MENU') || !notFound.includes('lang="sv-SE"') || logoHref(notFound) !== '/sv/') {
      fail('[language-sections] Swedish 404 lacks its text, home link, header or language');
    }
    const rootNotFound = readFileSync(join(outDir, '404.html'), 'utf8');
    if (!rootNotFound.includes('Sivua ei löydy') || !rootNotFound.includes('FI-MENU')) fail('[language-sections] root 404 is not the Finnish page');
    const ar = readFileSync(join(outDir, 'ar', 'index.html'), 'utf8');
    if (!/<html lang="ar" dir="rtl"/.test(ar) || !ar.includes('<style data-direction>')) fail('[language-sections] Arabic page is not right to left');
    if (/<html[^>]* dir=/.test(sv) || sv.includes('data-direction') || /<html[^>]* dir=/.test(fi)) fail('[language-sections] a left-to-right page got a direction');
    const arNotFound = readFileSync(join(outDir, 'ar', '404.html'), 'utf8');
    if (!/<html lang="ar" dir="rtl"/.test(arNotFound) || !arNotFound.includes('لم يتم العثور على الصفحة') || !arNotFound.includes('href="/ar/"')) fail('[language-sections] Arabic 404 is not right to left in Arabic');
    const llms = readFileSync(join(outDir, 'llms.txt'), 'utf8');
    if (!llms.includes('## Pages (sv-SE)') || llms.indexOf('## Pages (sv-SE)') < llms.indexOf('## Pages\n') || !llms.includes('](https://smoke.test/sv/artikel/)')) fail('[language-sections] llms.txt does not group the Swedish section after the site language');
    if (!existsSync(join(outDir, 'sv', 'artikel', 'index.md'))) fail('[language-sections] Swedish page has no Markdown file');
    log('[language-sections] ✓ per-language header, banner, home crumb, logo link, 404, right-to-left Arabic, llms.txt groups and Markdown');
  });
})();

// Scenario: an AI crawler policy and hreflang alternates. robots.txt carries the
// Content Signal and training-crawler groups without touching search
// crawlers, and the sitemap lists each page's hreflang cluster.
await (async function aiCrawlerPolicyScenario() {
  const tmpFixtures = mkdtempSync(join(tmpdir(), 'tr-smoke-fx-ai-'));
  process.on('exit', () => {
    try { rmSync(tmpFixtures, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
  const version = join(tmpFixtures, 'organizations', 'default', 'sites', 'default', 'versions', 'main');
  const settingsPath = join(version, 'settings', 'default.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.ai_crawler_policy = 'no_training';
  writeFileSync(settingsPath, JSON.stringify(settings));
  const aboutPath = readdirSync(join(version, 'pages')).filter(name => name.endsWith('.json')).map(name => join(version, 'pages', name))
    .find(file => JSON.parse(readFileSync(file, 'utf8')).slug === 'about');
  if (!aboutPath) fail('[ai-crawler-policy] fixture about page not found');
  const about = JSON.parse(readFileSync(aboutPath, 'utf8'));
  about.language = 'en';
  about.alternates = [{ hreflang: 'sv', href: 'https://smoke.test/sv/om/' }];
  writeFileSync(aboutPath, JSON.stringify(about));
  await build('ai-crawler-policy', { TYPEROLL_FIXTURES_DIR: tmpFixtures }, (outDir) => {
    const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');
    if (!/User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n/.test(robots)) fail('[ai-crawler-policy] robots.txt lacks the Content Signal in the wildcard group');
    if (!robots.includes('User-agent: GPTBot\nDisallow: /')) fail('[ai-crawler-policy] robots.txt does not disallow GPTBot');
    if (/^User-agent: (Googlebot|Bingbot|Applebot)$/m.test(robots)) fail('[ai-crawler-policy] robots.txt names a search crawler');
    const tail = robots.trimEnd().split('\n').slice(-2);
    if (tail[0] !== 'Sitemap: https://smoke.test/sitemap.xml' || tail[1] !== 'Sitemap: https://smoke.test/sitemap-images.xml') fail('[ai-crawler-policy] Sitemap lines are not at the end');
    const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
    if (!sitemap.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"')) fail('[ai-crawler-policy] sitemap lacks the xhtml namespace');
    if (!sitemap.includes('<xhtml:link rel="alternate" hreflang="sv" href="https://smoke.test/sv/om/"/>') || !sitemap.includes('<xhtml:link rel="alternate" hreflang="en" href="https://smoke.test/about/"/>')) fail('[ai-crawler-policy] sitemap lacks the hreflang cluster');
    log('[ai-crawler-policy] ✓ Content Signal, training-crawler groups and sitemap hreflang');
  });
})();

log('OK — all smoke scenarios passed');
process.exit(0);
