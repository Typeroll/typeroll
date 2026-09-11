#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const routes = JSON.parse(readFileSync(path.resolve(root, '../../temp/docs-migration/routes.json'), 'utf8'));
const shaIndex = process.argv.indexOf('--source-sha');
const expectedSha = shaIndex >= 0 ? process.argv[shaIndex + 1] : null;
async function request(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'TyperollDocsVerification/1.0' }, ...options });
      if (response.status >= 500 && attempt < 3) { await response.arrayBuffer(); await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
      return response;
    } catch (error) { if (attempt === 3) throw error; }
  }
}
if (expectedSha) {
  const result = await request('https://typeroll.com/docs/release.json');
  assert.equal(result.status, 200);
  assert.equal((await result.json()).source_commit, expectedSha, 'Live docs do not match the deployed source');
}
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < routes.length) {
    const route = routes[next++];
    const response = await request(route.destination);
    assert.equal(response.status, 200, route.destination);
    const html = await response.text();
    assert.ok(!html.includes('docs.typeroll.com'), 'Retired hostname in ' + route.destination);
    const structured = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(([, json]) => JSON.parse(json));
    assert.ok(structured.length > 0, 'Missing JSON-LD at ' + route.destination);
    if (route.destination === 'https://typeroll.com/docs/') {
      assert.ok(structured.some(data => data['@type'] === 'SoftwareApplication' && data.url === 'https://typeroll.com/'));
    } else {
      const breadcrumbs = structured.find(data => data['@type'] === 'BreadcrumbList');
      assert.equal(breadcrumbs?.itemListElement.at(-1).item, route.destination);
    }
    const canonical = [...html.matchAll(/<link\b[^>]+>/g)].map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))).find(tag => tag.rel === 'canonical');
    assert.equal(canonical?.href, route.destination);
    assert.doesNotMatch(response.headers.get('x-robots-tag') ?? '', /noindex/i);
    assert.doesNotMatch(html, /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i);
    const text = await request(new URL('index.txt', route.destination));
    assert.equal(text.status, 200);
    assert.match(text.headers.get('content-type'), /text\/plain/);
    assert.ok((await text.text()).includes(`](${route.destination})`));

  }
}));
for (const name of ['llms.txt', 'llms-full.txt', 'llms-small.txt']) {
  const response = await request(`https://typeroll.com/docs/${name}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.ok((await response.text()).length > 1000);
}
const missing = await request('https://typeroll.com/docs/__missing_documentation_check__/');
assert.equal(missing.status, 404);
assert.match(await missing.text(), /noindex/);
const entry = await request('https://typeroll.com/docs?via=check');
assert.equal(entry.status, 301);
assert.equal(entry.headers.get('location'), 'https://typeroll.com/docs/?via=check');
const readText = async (url) => {
  const response = await request(url);
  assert.equal(response.status, 200, url);
  const body = await response.text();
  assert.ok(!body.includes('docs.typeroll.com'), 'Retired hostname in ' + url);
  return body;
};
const rootRobots = await readText('https://typeroll.com/robots.txt');
assert.match(rootRobots, /User-agent: \*/);
assert.match(rootRobots, /Allow: \//);
assert.doesNotMatch(rootRobots, /Disallow: \/\s*(?:\n|$)/);
assert.ok(rootRobots.includes('Sitemap: https://typeroll.com/docs/sitemap-index.xml'));
assert.ok(rootRobots.includes('Sitemap: https://typeroll.com/sitemap.xml'));
const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);
const rootUrls = locs(await readText('https://typeroll.com/sitemap.xml'));
assert.ok(rootUrls.includes('https://typeroll.com/'));
assert.ok(rootUrls.every(url => new URL(url).origin === 'https://typeroll.com'));
assert.deepEqual(locs(await readText('https://typeroll.com/docs/sitemap-index.xml')), ['https://typeroll.com/docs/sitemap-0.xml']);
assert.deepEqual(locs(await readText('https://typeroll.com/docs/sitemap-0.xml')).sort(), routes.map(route => route.destination).sort());
const rootHtml = await readText('https://typeroll.com/');
const rootData = [...rootHtml.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(([, json]) => JSON.parse(json));
assert.ok(rootData.some(data => data['@type'] === 'WebSite' && data.url === 'https://typeroll.com/'));
const schemaUrl = 'https://typeroll.com/docs/specs/typeroll-extension-manifest-v3.schema.json';
assert.equal(JSON.parse(await readText(schemaUrl)).$id, schemaUrl);
console.log(`Verified ${routes.length} live HTML pages and text alternatives, agent indexes, canonical URLs, robots, sitemaps, JSON-LD, schema URL, 404 and query preservation.`);
