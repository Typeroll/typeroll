import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);
const text = node => node.value ?? node.children?.map(text).join('') ?? '';

export function agentDocuments(input, pages) {
  const byTitle = new Map(pages.map(page => [page.title, page]));
  assert.equal(byTitle.size, pages.length, 'Agent export requires unique page titles to match the plugin output');
  const tree = markdown.parse(input.replace(/^<SYSTEM>[^\n]*<\/SYSTEM>\s*\n/, ''));
  const sections = [];
  let current;
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      const title = text(node);
      const page = byTitle.get(title);
      assert.ok(page, `Unknown top-level heading in agent export: ${title}`);
      current = { page, nodes: [node, ...markdown.parse(`Source: [${title}](${page.url})`).children] };
      sections.push(current);
    } else if (current) {
      current.nodes.push(node);
    } else {
      assert.fail('Unexpected content before the first exported page');
    }
  }
  assert.equal(sections.length, pages.length, 'Agent export must include every public documentation page');
  assert.equal(new Set(sections.map(section => section.page.url)).size, pages.length, 'Agent export repeats a page');
  return sections.map(({ page, nodes }) => {
    function resolveLinks(node) {
      if (['link', 'image', 'definition'].includes(node.type)) node.url = new URL(node.url, page.url).href;
      for (const child of node.children ?? []) resolveLinks(child);
    }
    const root = { type: 'root', children: nodes };
    resolveLinks(root);
    return { ...page, content: markdown.stringify(root) };
  });
}
