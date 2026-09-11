#!/usr/bin/env node
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { docsTarget } from './docs-target.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = docsTarget();
const dist = path.resolve(root, target.output);
const repository = path.resolve(root, '../..');
const origin = target.site;
const pageUrl = route => target.publicUrl + route.slice(1);
const read = (file) => readFileSync(file, 'utf8');
const decode = (value) => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
}
function localFile(url) {
  let file = path.join(dist, decodeURIComponent(url.pathname.slice(target.base.length)));
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return file;
}
const htmlFiles = files(dist).filter(file => file.endsWith('.html'));
const sitemap = read(path.join(dist, 'sitemap-0.xml'));
const failures = [];
for (const file of htmlFiles) {
  const relative = path.relative(dist, file);
  const html = read(file);
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  const route = '/' + relative.replace(/index\.html$/, '');
  const is404 = relative === '404.html' || relative === '404/index.html';
  try {
    assert.equal([...head.matchAll(/<title>/g)].length, 1, 'Expected one document title');
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1, 'Expected one H1');
    const meta = [...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => attrs(tag));
    const robots = meta.filter(tag => tag.name === 'robots').map(tag => tag.content).join(' ');
    if (is404) { assert.match(robots, /noindex/); continue; }
    assert.doesNotMatch(robots, /noindex|none/);
    const canonicals = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => attrs(tag)).filter(tag => tag.rel === 'canonical');
    assert.deepEqual(canonicals.map(tag => tag.href), [pageUrl(route)], 'Expected a self-referencing canonical');
    assert.ok(sitemap.includes(`<loc>${pageUrl(route)}</loc>`), 'Page is missing from sitemap');
    const textUrl = new URL('index.txt', pageUrl(route)).href;
    assert.ok(html.includes(`href="${textUrl}"`), 'Missing discoverable page text alternative');
    assert.ok(read(path.join(dist, 'llms.txt')).includes(`](${textUrl})`), 'Agent index is missing this page');
    const pageText = read(localFile(new URL(textUrl)));
    assert.ok(pageText.includes(`](${pageUrl(route)})`), 'Page text is missing its source address');
    assert.ok(pageText.length > 100, 'Page text is empty');
    const edit = html.match(/https:\/\/github\.com\/typeroll\/typeroll\/edit\/main\/([^"<>]+)/)?.[1];
    assert.ok(edit && existsSync(path.join(repository, edit)), `Edit link must resolve to a real source file: ${edit}`);
    assert.equal((edit.match(/src\/content\/docs/g) ?? []).length, 1, 'Edit path is duplicated');
    const jsonLd = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, tag]) => attrs(tag).type === 'application/ld+json').map(([, , json]) => JSON.parse(json));
    assert.equal(jsonLd.length, 1, 'Expected one structured-data block');
    if (route === '/') {
      assert.equal(jsonLd[0]['@type'], 'SoftwareApplication');
      assert.equal(jsonLd[0].name, 'Typeroll CMS');
      assert.equal(jsonLd[0].offers.price, '0');
      const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? '';
      assert.equal((title.match(/Typeroll CMS/g) ?? []).length, 1, 'Homepage repeats the product name in its title');
      assert.match(html, /<h1[^>]*>Typeroll CMS<\/h1>/);
      assert.ok(meta.find(tag => tag.name === 'description')?.content.length <= 155, 'Homepage description exceeds the editorial limit');
    } else {
      assert.equal(jsonLd[0]['@type'], 'BreadcrumbList');
      assert.equal(jsonLd[0].itemListElement.at(-1).item, pageUrl(route));
      assert.match(html, /aria-label="Breadcrumb"/);
    }
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"<>]+)"/g)) {
      const url = new URL(decode(raw), pageUrl(route));
      if (url.origin !== origin) continue;
      if (target.base !== '/' && url.pathname === '/') continue;
      assert.ok(url.pathname.startsWith(target.base), `Link escapes documentation base: ${url.pathname}`);
      assert.ok(existsSync(localFile(url)), `Broken internal link or asset: ${url.pathname}`);
    }
  } catch (error) { failures.push(`${relative}: ${error.message}`); }
}
const robots = read(path.join(dist, 'robots.txt'));
assert.match(robots, /User-agent: \*/);
assert.match(robots, /Allow: \//);
assert.ok(robots.includes(`Sitemap: ${target.publicUrl}sitemap-index.xml`));
assert.doesNotMatch(robots, /Disallow:\s*\/\s*$/m);
assert.ok(read(path.join(dist, 'sitemap-index.xml')).includes(`${target.publicUrl}sitemap-0.xml`));
assert.doesNotMatch(sitemap, /<loc>[^<]*\/404\/?<\/loc>/);
const markdown = unified().use(remarkParse).use(remarkGfm);
for (const name of ['llms.txt', 'llms-full.txt', 'llms-small.txt', ...htmlFiles.filter(file => file.endsWith('index.html')).map(file => path.relative(dist, file).replace(/\.html$/, '.txt'))]) {
  const content = read(path.join(dist, name));
  assert.ok(content.length > 200, `${name} is empty`);
  if (name.startsWith('llms')) assert.match(content, /Typeroll CMS/);
  assert.doesNotMatch(content, /Build sites with Claude/);
  assert.doesNotMatch(content, /<SYSTEM>/);
  function checkLinks(node) {
    if (['link', 'image', 'definition'].includes(node.type)) {
      assert.match(node.url, /^[a-z][a-z\d+.-]*:/i, `${name}: agent link must be absolute: ${node.url}`);
      const url = new URL(node.url);
      if (url.origin === origin && url.pathname.startsWith(target.base)) {
        if (!(target.base !== '/' && url.pathname === '/')) assert.ok(existsSync(localFile(url)), `${name}: broken agent link: ${node.url}`);
      }
    }
    for (const child of node.children ?? []) checkLinks(child);
  }
  checkLinks(markdown.parse(content));
}
assert.match(read(path.join(dist, 'llms-full.txt')), /Migrate from Wix/);
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`Verified ${htmlFiles.length} HTML files: titles, canonicals, indexing, edit links, structured data, internal links, assets and agent documentation.`);
