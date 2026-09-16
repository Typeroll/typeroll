#!/usr/bin/env node
// Synthetic content only: no credentials, provider calls or customer exports.
import { performance } from 'node:perf_hooks';
import { replaceReferences } from './fixtures/static-publication/references.mjs';
import { publicationContentFiles } from './fixtures/static-publication/content.mjs';
import { digest } from './lib/customer-publishing.mjs';
const aliases = new Map(Array.from({ length: 337 }, (_, i) => [`https://media.example.org/old/image-${i}.jpg`, `https://site.example.org/media/image-${i}.jpg`]));
const content = { pages: Array.from({ length: 258 }, (_, i) => ({ id: `page-${i}`, title: `Article ${i}`, blocks: Array.from({ length: 30 }, (_, k) => ({ id: `block-${k}`, type: 'prose', data: { html: `<p>${'Public article text. '.repeat(15)} <img src="https://media.example.org/old/image-${(i + k) % 337}.jpg"></p>` } })) })) };
const start = performance.now();
replaceReferences(content, aliases);
const rewritten = performance.now();
const files = publicationContentFiles(content);
const checksums = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)]));
const frozen = performance.now();
content.pages[0].title = 'Changed page';
const next = publicationContentFiles(content);
const changed = Object.keys(next).filter(name => checksums[name] !== digest(next[name]));
console.log(JSON.stringify({ pages: 258, media_aliases: 337, source_bytes: Buffer.byteLength(JSON.stringify(content)), builder_rewrite_ms: Math.round(rewritten - start), cms_serialization_hash_ms: Math.round(frozen - rewritten), changed_files: changed, changed_content_bytes: changed.reduce((sum, name) => sum + Buffer.byteLength(next[name]), 0), note: 'Local CPU measurements; excludes CMS reads, queues and provider network latency.' }, null, 2));
