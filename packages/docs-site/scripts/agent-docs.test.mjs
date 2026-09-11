import assert from 'node:assert/strict';
import test from 'node:test';
import { docsTarget } from './docs-target.mjs';
import { agentDocuments } from './agent-docs.mjs';
import { waitForDocsRelease } from './wait-for-docs-release.mjs';

const pages = [
  { title: 'Editor', url: 'https://typeroll.com/docs/guides/editor/' },
  { title: 'Publishing', url: 'https://typeroll.com/docs/publishing/cloudflare/' },
];
const source = `<SYSTEM>Documentation</SYSTEM>

# Editor

[Publish](../../publishing/cloudflare/?version=main#builds)
![Screen](../../images/editor.png)
[Section](#fields)
[External](https://example.com/other)
[Reference][setup]

[setup]: ../setup/

| Field | Value |
| --- | --- |
| title | Editor |

\`\`\`html
<a href="/customer-page">Example</a>
# This is inside code
\`\`\`

# Publishing

[Editor](../../guides/editor/)
`;

test('combined and individual exports resolve links using each original page, preserving examples and tables', () => {
  const [editor, publishing] = agentDocuments(source, pages);
  assert.match(editor.content, /Source: \[Editor\]\(https:\/\/typeroll.com\/docs\/guides\/editor\/\)/);
  assert.ok(editor.content.includes('https://typeroll.com/docs/publishing/cloudflare/?version=main#builds'));
  assert.ok(editor.content.includes('https://typeroll.com/docs/images/editor.png'));
  assert.ok(editor.content.includes('https://typeroll.com/docs/guides/editor/#fields'));
  assert.ok(editor.content.includes('https://typeroll.com/docs/guides/setup/'));
  assert.ok(editor.content.includes('https://example.com/other'));
  assert.ok(editor.content.includes('<a href="/customer-page">Example</a>\n# This is inside code'));
  assert.match(editor.content, /\| Field\s*\| Value/);
  assert.ok(publishing.content.includes('https://typeroll.com/docs/guides/editor/'));
  assert.doesNotMatch(editor.content, /<SYSTEM>/);
});

test('exports resolve links against the supplied canonical source', () => {
  const [editor] = agentDocuments(source, pages.map(page => ({ ...page, url: page.url.replace('https://typeroll.com/docs/', 'https://docs.example.test/') })));
  assert.ok(editor.content.includes('https://docs.example.test/publishing/cloudflare/?version=main#builds'));
  assert.doesNotMatch(editor.content, /https:\/\/typeroll.com\/docs\//);
});

test('missing, repeated and ambiguous pages fail instead of producing partial or misattributed agent docs', () => {
  assert.throws(() => agentDocuments('# Editor\nOnly one page', pages), /every public documentation page/);
  assert.throws(() => agentDocuments('# Editor\n\n# Editor', pages), /repeats a page/);
  assert.throws(() => agentDocuments('# Unknown', pages), /Unknown top-level heading/);
  assert.throws(() => agentDocuments(source, [pages[0], { ...pages[1], title: 'Editor' }]), /unique page titles/);
});

test('documentation builds only use the canonical subdirectory', () => {
  assert.equal(docsTarget({}).publicUrl, 'https://typeroll.com/docs/');
  assert.equal(docsTarget({}).base, '/docs/');
  assert.throws(() => docsTarget({ TYPEROLL_DOCS_TARGET: 'subdomain' }), /only published/);
});

test('live verification waits for the deployed source and fails if it never arrives', async () => {
  const versions = ['previous', 'previous', 'deployed'];
  let waits = 0;
  await waitForDocsRelease('deployed', async () => versions.shift(), {
    attempts: 3,
    delay: async () => { waits++; },
  });
  assert.equal(waits, 2);
  await assert.rejects(waitForDocsRelease('deployed', async () => 'previous', {
    attempts: 3,
    delay: async () => {},
  }), /do not match the deployed source/);
});
