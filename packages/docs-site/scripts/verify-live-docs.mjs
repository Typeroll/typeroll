#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const routes = JSON.parse(readFileSync(path.resolve(root, '../../temp/docs-migration/redirect-checklist.json'), 'utf8'));
const redirects = process.argv.includes('--redirects');
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
    const canonical = [...html.matchAll(/<link\b[^>]+>/g)].map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))).find(tag => tag.rel === 'canonical');
    assert.equal(canonical?.href, route.destination);
    assert.doesNotMatch(response.headers.get('x-robots-tag') ?? '', /noindex/i);
    assert.doesNotMatch(html, /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i);
    const text = await request(new URL('index.txt', route.destination));
    assert.equal(text.status, 200);
    assert.match(text.headers.get('content-type'), /text\/plain/);
    assert.ok((await text.text()).includes(`](${route.destination})`));
    if (redirects) {
      const old = await request(route.source);
      assert.equal(old.status, 301, route.source);
      assert.equal(old.headers.get('location'), route.destination);
    }
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
for (const source of ['https://typeroll.com/docs?via=check', ...(redirects ? ['https://docs.typeroll.com/guides/the-editor/?via=check'] : [])]) {
  const response = await request(source);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), source.includes('docs.typeroll.com') ? 'https://typeroll.com/docs/guides/the-editor/?via=check' : 'https://typeroll.com/docs/?via=check');
}
console.log(`Verified ${routes.length} live HTML pages and text alternatives, agent indexes, canonical URLs, 404 and query preservation${redirects ? ', including all old-domain redirects' : ''}.`);
