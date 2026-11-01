#!/usr/bin/env node
// Writes one docs page per MCP skill and the overview's skill list.
// `--check` fails instead of writing when the committed pages differ.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { overviewContent, overviewFile, skillPages, staleSkillPages } from './skill-pages.mjs';

const check = process.argv.includes('--check');
const pages = skillPages();
const changes = [];
for (const page of pages) {
  if (!existsSync(page.file) || readFileSync(page.file, 'utf8') !== page.content) {
    changes.push(path.basename(page.file));
    if (!check) writeFileSync(page.file, page.content);
  }
}
for (const file of staleSkillPages(pages)) {
  changes.push(`remove ${path.basename(file)}`);
  if (!check) rmSync(file);
}
const overview = readFileSync(overviewFile, 'utf8');
const nextOverview = overviewContent(overview, pages);
if (overview !== nextOverview) {
  changes.push('overview.mdx');
  if (!check) writeFileSync(overviewFile, nextOverview);
}
if (check && changes.length) {
  console.error(`Skill docs are out of date with packages/mcp-server/skills: ${changes.join(', ')}.\nRun: npm run generate:skill-pages -w @typeroll/docs-site`);
  process.exit(1);
}
console.log(check ? `Skill docs match ${pages.length} skills.` : `Skill docs: ${changes.length ? changes.join(', ') : 'no changes'} (${pages.length} skills).`);
