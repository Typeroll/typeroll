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
      site: { name: 'Example', domain: 'example.test' }, settings: { site_name: 'Example', trailing_slash: slash, colors: {}, fonts: {} },
      pages: [page('home', { slug: '', html_content: '<h1>Home</h1><a href="/states/">States</a><img alt="" src="/decorative.svg">' }), page('companies'),
        page('abc', { content_type: 'supplier', fields: { company: 'ABC', city: 'Town' } }),
        page('nested', { content_type: 'supplier', slug: 'nested/profile' }), page('explicit', { path: '/special/nested/' }),
        page('states', { noindex: true }), page('strict', { noindex: true, nofollow: true }),
        page('syndicated', { canonical_url: 'https://original.test/article/' }),
      ], contentTypes: [{ id: 'supplier', name: 'supplier', label_singular: 'Supplier', label_plural: 'Companies', route_template: '/companies/{slug}/', schema_type: 'Organization', schema_field_map: { company: 'name' }, fields: [{ name: 'company', type: 'text' }, { name: 'city', type: 'text' }] }],
      forms: [], extensions: [], partials: [], blockTypes: [], pageTemplates: [], media: [], redirects: [],
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
    const suffix = slash === 'always' ? '/' : '';
    const html = await fs.readFile(path.join(destination, 'dist/companies/abc/index.html'), 'utf8');
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(match => JSON.parse(match[1]));
    const crumbs = schemas.filter(schema => schema['@type'] === 'BreadcrumbList');
    assert.equal(crumbs.length, 1);
    assert.deepEqual(crumbs[0].itemListElement.map(item => item.item), ['https://example.test/', 'https://example.test/companies' + suffix, 'https://example.test/companies/abc' + suffix]);
    assert.ok(!schemas.some(schema => Object.keys(schema).some(key => key.includes('.'))));
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
    assert.equal(render.reused, 8);
    assert.equal(second.report.artifact_tree_sha256, first.report.artifact_tree_sha256);
    // Previous renderer cache format and validator code cannot inherit a pass.
    const cachePath = path.join(destination, '.publication-cache.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    await fs.writeFile(cachePath, JSON.stringify({ ...cache, format: 3 }));
    await run();
    const cold = JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8'));
    assert.equal(cold.reused, 0); assert.equal(cold.reason, 'no_valid_cache');
    const validatorPath = path.join(destination, 'packages/site-template/src/lib/publication-validation.mjs');
    const validator = await fs.readFile(validatorPath, 'utf8');
    await fs.writeFile(validatorPath, validator.replace('SEO_VALIDATOR_VERSION = 1', 'SEO_VALIDATOR_VERSION = 2'));
    const revised = await run();
    assert.equal(revised.report.version, 2);
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
