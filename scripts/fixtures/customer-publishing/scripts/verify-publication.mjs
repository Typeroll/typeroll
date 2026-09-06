import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const content = readFileSync(new URL('../publication.json', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../publication-manifest.json', import.meta.url), 'utf8'));
if (manifest.format_version !== 1 || manifest.content_sha256 !== createHash('sha256').update(content).digest('hex')) {
  throw new Error('Publication content does not match its frozen manifest');
}
