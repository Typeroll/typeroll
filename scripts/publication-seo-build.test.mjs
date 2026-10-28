import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticPublicationProject, projectStaticPublication, sealPublicationProject } from './lib/static-publication.mjs';

test('frozen customer publication validates real Astro HTML, resolved routes, robots and cached pages', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-seo-publication-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const page = (id, extra = {}) => ({ id, title: id, slug: id, status: 'published', content_mode: 'html', html_content: `<h1>${id}</h1>`, ...extra });
  for (const slash of ['always', 'never']) {
    const input = {
      site: { name: 'Example', domain: 'example.test' }, settings: { site_name: 'Example', language: 'sv', default_og_image: '/default.jpg', render_version: 10, typography:{ratio_mobile:1.2,ratio_desktop:1.3,rhythm:1.2,line_length:68}, trailing_slash: slash, colors: {surface:'#f8fafc'}, fonts: {mono:'Roboto Mono'}, design_scales:{space:{lg:{mobile:'2rem',desktop:'clamp(2rem, 1rem + 2vw, 4rem)'}}}, external_routes: [{ path: "/docs/", owner: "Documentation deployment" }] },
      pages: [page('home', { slug: '', html_content: '<h1>Home</h1><a href="/states/">States</a><a href="https://example.test/docs/">Documentation</a><img alt="" src="/decorative.svg">' }), page('companies'),
        page('abc', { content_type: 'supplier', og_title: 'Share ABC', og_description: 'Sharing ABC', fields: { company: 'ABC', city: 'Town', featured_image: 'https://example.test/media/company.jpg', featured_image_alt: 'ABC team' } }),
        page('nested', { content_type: 'supplier', slug: 'nested/profile' }), page('explicit', { path: '/special/nested/' }),
        page('states', { noindex: true }), page('strict', { noindex: true, nofollow: true }),
        page('syndicated', { canonical_url: 'https://original.test/article/' }),
        page('dated-article', { kind: 'article', date_published: '2024-05-02T10:01:08Z', date_updated: '2024-05-03T11:01:08+01:00' }),
        page('tokens', { content_mode:'blocks', html_content:undefined, blocks:[{id:'panel',type:'token_panel',data:{background:'surface',gap_px:'lg'}}] }),
        page('legacy-dated-article', { kind: 'article', date_published: '2024-05-02T11:01:08' }),
      ], contentTypes: [{ id: 'supplier', name: 'supplier', label_singular: 'Supplier', label_plural: 'Companies', route_template: '/companies/{slug}/', schema_type: 'Organization', schema_field_map: { featured_image: 'image', company: 'name' }, fields: [{ name: 'company', type: 'text' }, { name: 'featured_image', type: 'image' }, { name: 'featured_image_alt', type: 'text' }, { name: 'city', type: 'text' }] }],
      forms: [], extensions: [], partials: [], blockTypes: [{id:'token_panel',name:'token_panel',label:'Token panel',container:false,
        schema:[{name:'background',type:'color'},{name:'gap_px',type:'number',css_unit:'px',design_token:'space'}],
        template:'<section data-block="token_panel" style="background:{{background}};padding:var(--gap_px)"><p>Palette and spacing</p></section>'}], pageTemplates: [], media: [], redirects: [],
    };
    const publication = projectStaticPublication(input, { siteUrl: 'https://example.test', coreCommit: 'a'.repeat(40), publishedAt: '2026-09-18T00:00:00Z', noindex: false });
    const destination = path.join(temp, slash);
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    const run = async () => {
      await sealPublicationProject(destination);
      const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 60000 });
      return { result, report: JSON.parse(await fs.readFile(path.join(destination, '.publication-work/seo-report.json'), 'utf8')) };
    };
    const first = await run();
    assert.equal(first.result.status, 0, first.result.stderr + first.result.stdout);
    assert.equal(first.report.passed, true);
    assert.ok(first.report.warnings.some(issue => issue.code === 'external_route_owned_elsewhere'));
    const suffix = slash === 'always' ? '/' : '';
    const html = await fs.readFile(path.join(destination, 'dist/companies/abc/index.html'), 'utf8');
    assert.match(html, /property="og:locale" content="sv_SE"/);
    assert.match(html, /property="og:title" content="Share ABC"/);
    assert.match(html, /name="twitter:title" content="Share ABC"/);
    assert.match(html, /property="og:description" content="Sharing ABC"/);
    assert.match(html, /property="og:image" content="https:\/\/example.test\/media\/company.jpg"/);
    assert.match(html, /property="og:image:alt" content="ABC team"/);
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(match => JSON.parse(match[1]));
    const crumbs = schemas.filter(schema => schema['@type'] === 'BreadcrumbList');
    assert.equal(crumbs.length, 1);
    assert.deepEqual(crumbs[0].itemListElement.map(item => item.item), ['https://example.test/', 'https://example.test/companies' + suffix, 'https://example.test/companies/abc' + suffix]);
    assert.ok(!schemas.some(schema => Object.keys(schema).some(key => key.includes('.'))));
    const tokenHtml = await fs.readFile(path.join(destination, 'dist/tokens/index.html'),'utf8');
    assert.match(tokenHtml,/--space-lg:2rem/);
    assert.match(tokenHtml,/--space-lg:clamp\(2rem, 1rem \+ 2vw, 4rem\)/);
    assert.match(tokenHtml,/--type-size-3xl:clamp\(/);
    assert.match(tokenHtml,/--measure-prose:68ch/);
    assert.match(tokenHtml,/--type-h2:var\(--type-size-2xl\)/);
    assert.match(tokenHtml,/--gap_px:var\(--space-lg\)/);
    assert.match(tokenHtml,/background:var\(--color-surface\)/);
    assert.match(tokenHtml,/--font-mono:[^;]*Roboto Mono/);
    const datedHtml = await fs.readFile(path.join(destination, 'dist/dated-article/index.html'), 'utf8');
    assert.match(datedHtml, /"datePublished":"2024-05-02T10:01:08Z"/);
    assert.match(datedHtml, /"dateModified":"2024-05-03T11:01:08\+01:00"/);
    const legacyHtml = await fs.readFile(path.join(destination, 'dist/legacy-dated-article/index.html'), 'utf8');
    assert.match(legacyHtml, /"datePublished":"2024-05-02"/);
    assert.ok(!legacyHtml.includes('"datePublished":"2024-05-02T11:01:08'));
    assert.match(await fs.readFile(path.join(destination, 'dist/states/index.html'), 'utf8'), /content="noindex,follow"/);
    assert.match(await fs.readFile(path.join(destination, 'dist/strict/index.html'), 'utf8'), /content="noindex,nofollow"/);
    assert.ok(!(await fs.readFile(path.join(destination, 'dist/sitemap.xml'), 'utf8')).includes('/states'));
    const home = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8'); assert.ok(!home.includes('BreadcrumbList'));
    // Reintroduce the reported slug-only defect in the actual frozen renderer,
    // not a preview or a mock HTML assertion. The build must now fail.
    const headPath = path.join(destination, 'packages/site-template/src/components/SEOHead.astro');
    const headSource = await fs.readFile(headPath, 'utf8');
    await fs.writeFile(headPath, headSource.replace('const breadcrumbJsonLd = breadcrumbSchema();',
      "const breadcrumbJsonLd = (() => { const value = breadcrumbSchema(); if (!value) return null; const schema = JSON.parse(value); schema.itemListElement.at(-1).item = new URL('/' + page.slug, Astro.site).href; return JSON.stringify(schema); })();"));
    const regression = await run();
    assert.notEqual(regression.result.status, 0);
    assert.ok(regression.report.errors.some(issue => issue.code === 'breadcrumb_route'));
    const beforeHtml = await fs.readFile(path.join(destination, 'dist/companies/abc/index.html'), 'utf8');
    await fs.writeFile(headPath, headSource);
    // A warm partial build still validates every generated/reused HTML file.
    const second = await run(); assert.equal(second.report.checked_pages, first.report.checked_pages);
    const render = JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8'));
    assert.equal(render.reused, input.pages.length);
    assert.equal(second.report.artifact_tree_sha256, first.report.artifact_tree_sha256);
    // Site-wide rhythm changes invalidate previously rendered pages as well.
    const settingsPath = path.join(destination, 'publication.json');
    const frozenSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    frozenSettings.settings.typography.rhythm = 1.4;
    await fs.writeFile(settingsPath, JSON.stringify(frozenSettings));
    const changedRhythm = await run();
    assert.equal(changedRhythm.result.status, 0, changedRhythm.result.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8')).reused, 0);
    assert.match(await fs.readFile(path.join(destination, 'dist/tokens/index.html'), 'utf8'), /--type-rhythm:1.4/);
    // Previous renderer cache format and validator code cannot inherit a pass.
    const cachePath = path.join(destination, '.publication-cache.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    await fs.writeFile(cachePath, JSON.stringify({ ...cache, format: 3 }));
    await run();
    const cold = JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8'));
    assert.equal(cold.reused, 0); assert.equal(cold.reason, 'no_valid_cache');
    const validatorPath = path.join(destination, 'packages/site-template/src/lib/publication-validation.mjs');
    const validator = await fs.readFile(validatorPath, 'utf8');
    await fs.writeFile(validatorPath, validator.replace(/SEO_VALIDATOR_VERSION = (\d+)/, (_, version) => `SEO_VALIDATOR_VERSION = ${Number(version) + 1}`));
    const revised = await run();
    assert.equal(revised.report.version, first.report.version); // Semantics change without breaking installed executors.
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8')).reused, 0);
    await fs.writeFile(validatorPath, validator);
    // Deliberately recreate the old mapping bug in the frozen source. No output
    // can pass publication just because JSON itself is syntactically valid.
    const source = JSON.parse(await fs.readFile(path.join(destination, 'content/contentTypes/supplier.json'), 'utf8'));
    source.schema_field_map.city = 'address.addressLocality';
    await fs.writeFile(path.join(destination, 'content/contentTypes/supplier.json'), JSON.stringify(source));
    const broken = await run(); assert.notEqual(broken.result.status, 0);
    assert.ok(broken.report.errors.some(issue => issue.code === 'schema_mapping_unsupported'));
    if (process.env.TYPEROLL_SEO_PROOF_DIR) {
      const output = path.resolve(process.env.TYPEROLL_SEO_PROOF_DIR, slash);
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'regression-head.html'), beforeHtml.slice(beforeHtml.indexOf('<head>'), beforeHtml.indexOf('</head>') + 7));
      await fs.writeFile(path.join(output, 'regression-report.json'), JSON.stringify(regression.report, null, 2) + '\n');
      await fs.writeFile(path.join(output, 'corrected-head.html'), html.slice(html.indexOf('<head>'), html.indexOf('</head>') + 7));
      await fs.writeFile(path.join(output, 'accepted-report.json'), JSON.stringify(first.report, null, 2) + '\n');
      await fs.writeFile(path.join(output, 'rejected-report.json'), JSON.stringify(broken.report, null, 2) + '\n');
      await fs.writeFile(path.join(output, 'cache-proof.json'), JSON.stringify({ warm: render, legacy_format: cold, validator_revision: { version: revised.report.version, validated_pages: revised.report.checked_pages } }, null, 2) + '\n');
    }
    delete source.schema_field_map.city;
    await fs.writeFile(path.join(destination, 'content/contentTypes/supplier.json'), JSON.stringify(source));
    const frozenPath = path.join(destination, 'publication.json');
    const privateVersion = JSON.parse(await fs.readFile(frozenPath, 'utf8'));
    privateVersion.robots_blocked = true;
    privateVersion.settings.sitewide_noindex = true;
    await fs.writeFile(frozenPath, JSON.stringify(privateVersion));
    const privateBuild = await run();
    assert.equal(privateBuild.result.status, 0, privateBuild.result.stderr);
    assert.match(await fs.readFile(path.join(destination, 'dist/companies/abc/index.html'), 'utf8'), /content="noindex,nofollow"/);
    assert.ok(!(await fs.readFile(path.join(destination, 'dist/sitemap.xml'), 'utf8')).includes('<loc>'));
  }
});
