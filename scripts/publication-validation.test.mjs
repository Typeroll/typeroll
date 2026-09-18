import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublication, outputDigest } from '../packages/site-template/src/lib/publication-validation.mjs';
import { seoReport, outputDigest as trustedDigest } from '../packages/portal/src/lib/builds/contract.mjs';
import { robotsAllows } from '../packages/site-template/src/lib/robots-policy.mjs';

const origin = 'https://example.test';
const html = (pathname, body = '', { canonical = origin + pathname, robots = 'index,follow', schema = '', title = pathname, description = pathname } = {}) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}"><meta name="robots" content="${robots}">${schema}</head><body>${body}</body></html>`;
const ld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
function fixture() {
  return { publication: { publication_id: 'a'.repeat(64), site_url: origin, settings: {}, contentTypes: [] }, sourceHash: 'b'.repeat(64),
    files: { 'index.html': html('/', '<a href="/companies/">Companies</a>'),
      'companies/index.html': html('/companies/', '<a href="/companies/abc/" aria-label="ABC"><img src="/logo.png" alt=""></a>'),
      'companies/abc/index.html': html('/companies/abc/', '<h1>ABC</h1>', { schema: ld({ '@type': 'BreadcrumbList', itemListElement: [
        { position: 1, item: origin + '/' }, { position: 2, item: origin + '/companies/' }, { position: 3, item: origin + '/companies/abc/' },
      ] }) }),
      'sitemap.xml': `<urlset><url><loc>${origin}/companies/abc/</loc></url></urlset>`, 'robots.txt': 'User-agent: *\nAllow: /',
    }, routes: [{ pathname: '/companies/abc/', page_id: 'abc', canonical: origin + '/companies/abc/', breadcrumbs: [{ item: origin + '/' }, { item: origin + '/companies/' }, { item: origin + '/companies/abc/' }] }] };
}
test('correct artifact passes with an identity-bound report', () => {
  const report = validatePublication(fixture());
  assert.deepEqual(report.errors, []);
  assert.equal(seoReport(report, 'a'.repeat(64)).passed, true);
  assert.throws(() => seoReport(report, 'c'.repeat(64)), /report_invalid/);
  const files = { b: { sha256: 'b'.repeat(64), size: 2 }, a: { sha256: 'a'.repeat(64), size: 1 } };
  assert.equal(outputDigest(files), trustedDigest(files));
});
test('inspection product uses documented Googlebot fallback, not UA substring matching', () => {
  const policy = 'User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /';
  assert.equal(robotsAllows(policy, '/companies/', 'Google-InspectionTool'), true);
  assert.equal(robotsAllows(policy, '/companies/', 'Otherbot'), false);
  assert.equal(robotsAllows(policy + '\nUser-agent: Google-InspectionTool\nDisallow: /private/', '/private/', 'Google-InspectionTool'), false);
});
for (const [name, mutate, code] of [
  ['slug-only breadcrumb', f => { f.files['companies/abc/index.html'] = f.files['companies/abc/index.html'].replace(`"item":"${origin}/companies/abc/"`, `"item":"${origin}/abc"`); }, 'breadcrumb_route'],
  ['dotted schema map', f => { f.publication.contentTypes = [{ id: 'supplier', schema_field_map: { city: 'address.addressLocality' } }]; }, 'schema_mapping_unsupported'],
  ['primitive JSON-LD', f => { f.files['index.html'] += ld('not a node'); }, 'jsonld_malformed'],
  ['image sitemap noindex', f => { f.files['sitemap-images.xml'] = f.files['sitemap.xml']; f.files['sitemap.xml'] = '<urlset/>'; f.files['companies/abc/index.html'] = f.files['companies/abc/index.html'].replace('index,follow', 'noindex,follow'); }, 'sitemap_route_invalid'],
  ['named redirect loop', f => { f.files._redirects = '/old/:page /new/:page 301\n/new/:page /old/:page 301'; }, 'redirect_loop'],
  ['wildcard redirect loop', f => { f.files._redirects = '/old/* /new/:splat 301\n/new/* /old/:splat 301'; }, 'redirect_loop'],
  ['invalid JSON-LD', f => { f.files['index.html'] += '<script type="application/ld+json">{</script>'; }, 'jsonld_malformed'],
  ['dotted JSON-LD', f => { f.files['index.html'] += ld({ '@type': 'Organization', 'address.addressRegion': 'AZ' }); }, 'schema_property_invalid'],
  ['broken target', f => { f.files['index.html'] += '<a data-block-id="broken" href="/missing/">Missing</a>'; }, 'internal_target_missing'],
  ['redirect loop', f => { f.files._redirects = '/a /b 301\n/b /a 301'; }, 'redirect_loop'],
  ['unnamed linked image', f => { f.files['companies/index.html'] = f.files['companies/index.html'].replace(' aria-label="ABC"', ''); }, 'image_link_unnamed'],
  ['duplicate canonical', f => { f.files['index.html'] += `<link rel="canonical" href="${origin}/">`; }, 'canonical_conflict'],
  ['unconfigured cross-domain canonical', f => { f.files['index.html'] = html('/', '', { canonical: 'https://elsewhere.test/' }); }, 'canonical_conflict'],
  ['redirect in sitemap', f => { f.files._redirects = '/companies/abc/ /companies/ 301'; }, 'sitemap_route_invalid'],
  ['noindex in sitemap', f => { f.files['companies/abc/index.html'] = f.files['companies/abc/index.html'].replace('index,follow', 'noindex,follow'); }, 'sitemap_route_invalid'],
  ['homepage breadcrumb', f => { f.files['index.html'] += ld({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, item: origin + '/' }] }); }, 'breadcrumb_count'],
]) test(`rejects ${name} with a source locator`, () => {
  const f = fixture(); mutate(f); const report = validatePublication(f);
  assert.equal(report.passed, false);
  const issue = report.errors.find(issue => issue.code === code);
  assert.ok(issue, JSON.stringify(report)); assert.ok(issue.source.file); assert.ok(issue.source.line >= 1); assert.ok(issue.url);
});
test('intentional noindex, configured canonical, decorative image, fragments, repeated contextual links pass', () => {
  const f = fixture();
  f.files['private/index.html'] = html('/private/', '<img alt="" src="x.png"><a href="#client-filter">Filter</a>', { robots: 'noindex,follow' });
  f.files['syndicated/index.html'] = html('/syndicated/', '', { canonical: 'https://other.test/original/' });
  f.routes.push({ pathname: '/syndicated/', canonical: 'https://other.test/original/' });
  f.files['index.html'] += '<nav><a href="/private/">State pages</a></nav><footer><a href="/private/#dynamic">State pages</a></footer>';
  const result = validatePublication(f); assert.deepEqual(result.errors, []);
  assert.ok(!result.warnings.some(issue => issue.code === 'list_destination_repeated'));
});
test('editorial constraints revisit unchanged HTML and change configuration identity', () => {
  const f = fixture(); f.files['index.html'] = f.files['index.html'].replace('</body>', '<p>wave-1 supplier pages. Compare earnings.</p></body>');
  const before = validatePublication(f);
  f.publication.settings.seo_review = { forbidden_markers: ['wave-1'], claims: [{ phrase: 'compare earnings', guidance: 'The directory does not provide earnings comparisons; review the promise.' }] };
  const after = validatePublication(f);
  assert.equal(after.passed, true);
  assert.notEqual(after.configuration_sha256, before.configuration_sha256);
  assert.equal(after.artifact_tree_sha256, before.artifact_tree_sha256);
  assert.ok(after.warnings.some(issue => issue.code === 'forbidden_internal_marker'));
  assert.ok(after.warnings.some(issue => issue.code === 'editorial_claim_review'));
});
test('formatted image links retain their alt-based accessible name', () => {
  const f = fixture();
  f.files['index.html'] += '<a href="/companies/">\n  <img alt="Browse companies" src="logo.png">\n</a>';
  const report = validatePublication(f);
  assert.deepEqual(report.errors, []);
});
test('editorial warnings identify the affected content block and metadata field', () => {
  const f = fixture();
  f.files['index.html'] = html('/', '<section data-source-block-id="intro"><p>Internal research wave.</p></section>', { description: 'Compare earnings.' });
  f.publication.settings.seo_review = { forbidden_markers: ['internal research'], claims: [{ phrase: 'compare earnings', guidance: 'Review this promise.' }] };
  const report = validatePublication(f);
  assert.equal(report.warnings.find(issue => issue.code === 'forbidden_internal_marker').source.block_id, 'intro');
  assert.equal(report.warnings.find(issue => issue.code === 'editorial_claim_review').source.field, 'seo_description');
});
test('metadata, heading, list and navigation warnings never rewrite or reject copy', () => {
  const f = fixture(); f.files['index.html'] = html('/', '<h1>One</h1><h3>Three</h3><ul><li><a href="/companies/">About</a></li><li><a href="/companies/">Companies</a></li></ul>', { title: 'Fundraising Fundraising', description: '' });
  const original = JSON.stringify(f.files), report = validatePublication(f);
  assert.equal(report.passed, true); assert.equal(JSON.stringify(f.files), original);
  for (const code of ['title_repeated_word', 'heading_jump', 'metadata_missing', 'generic_link_text', 'list_destination_repeated']) assert.ok(report.warnings.some(issue => issue.code === code), code);
});
