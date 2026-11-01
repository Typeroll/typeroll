#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsTarget } from './docs-target.mjs';
import { agentDocuments } from './agent-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = docsTarget();
const dist = path.resolve(root, target.output);
const decode = value => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const pages = readdirSync(dist, { recursive: true })
  .filter(file => file.endsWith('index.html'))
  .map(file => {
    const html = readFileSync(path.join(dist, file), 'utf8');
    const json = html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!json) throw new Error(`Missing page metadata: ${file}`);
    const data = JSON.parse(json);
    const description = html.match(/<meta\b[^>]*name="description"[^>]*content="([^"]*)"/)?.[1]
      ?? html.match(/<meta\b[^>]*content="([^"]*)"[^>]*name="description"/)?.[1];
    return {
      title: data.name ?? data.itemListElement.at(-1).name,
      description: description ? decode(description) : '',
      route: file.replace(/index\.html$/, ''),
      url: new URL(file.replace(/index\.html$/, ''), target.publicUrl).href,
      textUrl: new URL(file.replace(/\.html$/, '.txt'), target.publicUrl).href,
      file: path.join(dist, file.replace(/\.html$/, '.txt')),
    };
  })
  .sort((a, b) => a.route.localeCompare(b.route));

const write = (file, complete) => {
  const documents = agentDocuments(readFileSync(file, 'utf8'), pages, { complete });
  writeFileSync(file, documents.map(page => page.content).join('\n---\n\n'));
  return documents;
};
for (const page of write(path.join(dist, 'llms-full.txt'), true)) writeFileSync(page.file, page.content);
write(path.join(dist, 'llms-small.txt'), false);
const sets = path.join(dist, '_llms-txt');
if (existsSync(sets)) for (const file of readdirSync(sets).filter(file => file.endsWith('.txt'))) write(path.join(sets, file), false);

// The index lists every page with its description, grouped by section.
const SECTIONS = [
  ['', 'Overview'],
  ['getting-started/', 'Getting started'],
  ['guides/', 'Guides'],
  ['skills/', 'Skills (agent recipes)'],
  ['tools/', 'MCP tool reference'],
  ['publishing/', 'Publishing'],
  ['apps/', 'Core modules'],
  ['extensions/', 'Extensions'],
  ['technical/', 'Technical reference'],
];
const sectionOf = page => [...SECTIONS].reverse().find(([prefix]) => prefix ? page.route.startsWith(prefix) : !page.route.includes('/'))?.[1] ?? 'Other';
const groups = new Map(SECTIONS.map(([, label]) => [label, []]));
for (const page of pages) {
  const label = sectionOf(page);
  if (!groups.has(label)) groups.set(label, []);
  groups.get(label).push(page);
}
const line = page => `- [${page.title}](${page.textUrl})${page.description ? `: ${page.description.replace(/\s+/g, ' ').trim()}` : ''}`;
const list = [...groups].filter(([, items]) => items.length)
  .map(([label, items]) => `### ${label}\n\n${items.map(line).join('\n')}`).join('\n\n');
const index = path.join(dist, 'llms.txt');
writeFileSync(index, readFileSync(index, 'utf8').trimEnd() + '\n\n## Individual pages\n\n' + list + '\n');
console.log(`Generated ${pages.length} agent-readable pages with absolute source and content links.`);
