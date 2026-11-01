#!/usr/bin/env node
// Builds the docs share image (public/images/typeroll-docs-share.png, 1200×630)
// from the brand wordmark. Rerun after a brand change and commit the PNG.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wordmark = readFileSync(path.join(root, 'public/brand/typeroll-main.svg'), 'utf8');
const inner = wordmark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const [, , width, height] = wordmark.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const scale = 640 / width;
const ink = '#172d25';
const paper = '#fbfaf6';
const magenta = '#c60075';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${paper}"/>
  <rect x="0" y="0" width="1200" height="14" fill="${magenta}"/>
  <g transform="translate(${(1200 - width * scale) / 2} ${230 - height * scale / 2}) scale(${scale})" fill="${ink}">${inner}</g>
  <text x="600" y="420" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="58" fill="${ink}">Documentation</text>
  <text x="600" y="490" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#53665c">Visual editing, AI agents and static publishing</text>
</svg>`;
const output = path.join(root, 'public/images/typeroll-docs-share.png');
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(output);
console.log(`Wrote ${path.relative(root, output)}`);
