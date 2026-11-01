import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { overviewContent, overviewFile, skillPages, skillsSource, staleSkillPages } from './skill-pages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = path.join(root, 'src/content/docs');
const pages = readdirSync(content, { recursive: true }).map(String).filter(file => /\.mdx?$/.test(file));
const frontmatter = file => readFileSync(path.join(content, file), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

test('every docs page has a title and a description', () => {
  const missing = pages.filter(file => !/^title:\s*\S/m.test(frontmatter(file)) || !/^description:\s*\S/m.test(frontmatter(file)));
  assert.deepEqual(missing, [], 'Add a description: to these pages; it feeds search results, link previews and llms.txt');
});

test('the sidebar lists each page once and every listed page exists', () => {
  const config = readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
  const slugs = [...config.matchAll(/slug:\s*['"]([^'"]+)['"]/g)].map(([, slug]) => slug);
  const repeated = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
  assert.deepEqual(repeated, [], 'A page is listed twice in the sidebar');
  const missing = slugs.filter(slug => !['.md', '.mdx', '/index.md', '/index.mdx'].some(ext => existsSync(path.join(content, slug + ext))));
  assert.deepEqual(missing, []);
});

test('every MCP skill has a generated docs page that matches its source', () => {
  const skills = readdirSync(skillsSource).filter(file => /^tr-[a-z0-9-]+\.md$/.test(file));
  const generated = skillPages();
  assert.equal(generated.length, skills.length);
  assert.ok(skills.includes('tr-edit-site.md'));
  for (const page of generated) {
    assert.ok(existsSync(page.file), `Missing docs page for ${page.name}`);
    assert.equal(readFileSync(page.file, 'utf8'), page.content, `${page.name} docs page is stale. Run npm run generate:skill-pages -w @typeroll/docs-site`);
  }
  assert.deepEqual(staleSkillPages(generated), [], 'A skill page has no source skill');
  const overview = readFileSync(overviewFile, 'utf8');
  assert.equal(overview, overviewContent(overview, generated), 'The skills overview list is stale');
});

test('generated skill pages keep code, escape placeholders and keep one title', () => {
  for (const page of skillPages()) {
    const body = page.content.split('\n---\n').slice(1).join('\n---\n');
    let fence = null;
    for (const line of body.split('\n')) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) { fence = fence ? null : marker; continue; }
      if (fence) continue;
      const prose = line.replace(/`+[^`]*`+/g, '');
      assert.doesNotMatch(prose, /^# /, `${page.name} has a second H1`);
      assert.doesNotMatch(prose, /<(?!!--)[a-zA-Z][\w-]*(?:\s[^>]*)?>/, `${page.name} has raw HTML-like text: ${line}`);
    }
    assert.equal(fence, null, `${page.name} has an unclosed code fence`);
  }
});

test('llms-small.txt pages exist', async () => {
  const { SMALL_PAGES } = await import('./llms-config.mjs');
  const missing = SMALL_PAGES.filter(id => !['.md', '.mdx'].some(ext => existsSync(path.join(content, id + ext))));
  assert.deepEqual(missing, [], 'Remove or create these llms-small.txt pages in scripts/llms-config.mjs');
});
