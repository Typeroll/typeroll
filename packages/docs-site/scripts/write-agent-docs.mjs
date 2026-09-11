#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsTarget } from './docs-target.mjs';
import { agentDocuments } from './agent-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = docsTarget();
const dist = path.resolve(root, target.output);
const pages = readdirSync(dist, { recursive: true })
  .filter(file => file.endsWith('index.html'))
  .map(file => {
    const html = readFileSync(path.join(dist, file), 'utf8');
    const json = html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!json) throw new Error(`Missing page metadata: ${file}`);
    const data = JSON.parse(json);
    return {
      title: data.name ?? data.itemListElement.at(-1).name,
      url: new URL(file.replace(/index\.html$/, ''), target.publicUrl).href,
      textUrl: new URL(file.replace(/\.html$/, '.txt'), target.publicUrl).href,
      file: path.join(dist, file.replace(/\.html$/, '.txt')),
    };
  });
for (const name of ['llms-full.txt', 'llms-small.txt']) {
  const file = path.join(dist, name);
  const documents = agentDocuments(readFileSync(file, 'utf8'), pages);
  writeFileSync(file, documents.map(page => page.content).join('\n---\n\n'));
  if (name === 'llms-full.txt') {
    for (const page of documents) writeFileSync(page.file, page.content);
  }
}
const index = path.join(dist, 'llms.txt');
writeFileSync(index, readFileSync(index, 'utf8') + '\n## Individual pages\n\n' +
  pages.map(page => `- [${page.title}](${page.textUrl})`).join('\n') + '\n');
console.log(`Generated ${pages.length} agent-readable pages with absolute source and content links.`);
