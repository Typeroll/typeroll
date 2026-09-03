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

function build(label, extraEnv) {
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
      log(`[${label}] OK — built ${EXPECTED_HTML_ROUTES.length} routes`);
      resolveBuild();
    });
  });
}

// Scenario 1: the normal deploy shape — fixtures dir set, no service account.
await build('fixtures', {});

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

// Scenario 3 (apps): the analytics app, when enabled for a site, injects a
// Cloudflare Web Analytics beacon into every page. We DON'T enable it in the
// committed fixtures (keeps the OSS sample clean) — instead copy the fixtures
// to a temp tree, drop in an enabled apps doc, build, and assert the beacon +
// its token appear in the output. This pins the getAppsPublic → BaseLayout
// injection path.
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
      log('[apps-analytics-beacon] ✓ beacon injected with token');
      res();
    });
  });
})();

// Scenario 4 (integrations app): tags are built from validated IDs and routed
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

// Scenario 5 (Extension directives in HTML partials): preview and static
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

// Scenario 6 (renderer additions): taxonomy routes, core/embed's per-instance
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
  const collDir = join(base, 'collections');

  // A listings collection with two facets. `city` has one value with two
  // items (a page) and one with a single item (below min_items, no page) —
  // so the run proves the guard fires rather than just that routes appear.
  writeFileSync(join(collDir, 'companies.json'), JSON.stringify({
    name: 'companies', label_singular: 'Company', label_plural: 'Companies',
    fields: [
      { name: 'title', label: 'Name', type: 'text', required: true },
      { name: 'city', label: 'City', type: 'text' },
    ],
    facets: [{ field: 'city', base_path: '/ort', label_singular: 'Ort' }],
    route_template: '/foretag/{slug}',
  }));
  // Items live under `collections/{name}/items/`, matching paths.collectionItems.
  const itemsDir = join(collDir, 'companies', 'items');
  mkdirSync(itemsDir, { recursive: true });
  const company = (id, title, city) => writeFileSync(
    join(itemsDir, `${id}.json`),
    JSON.stringify({ status: 'published', created_at: 'x', updated_at: 'x', title, slug: id, city }),
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
      id: 'blk_foot_list', type: 'core/collection_list',
      data: { collection: 'companies', sort_by: 'title', sort_order: 'asc', limit: 20 },
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
        fail('[directory-renderer] footer listing in a partial resolved no items — collectionSource missing');
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
      if ((hreflangPage.match(/rel="alternate"/g) ?? []).length !== 2) {
        fail('[directory-renderer] expected exactly 2 alternate links (self + de)');
      }

      log('[directory-renderer] ✓ facets gated + scoped, core/embed JS bundled outside the body');
      log('[directory-renderer] ✓ custom BlockType in a partial renders with its CSS + JS');
      log('[directory-renderer] ✓ hreflang cluster emitted with self-reference, junk dropped');
      res();
    });
  });
})();

// Scenario 7 (URL policy): Astro's output layout and generated discovery
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

log('OK — all smoke scenarios passed');
process.exit(0);
