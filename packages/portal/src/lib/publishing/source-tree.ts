import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './providers.mjs';
import { getStore } from '../datastore';

interface PublicationTemplate { format: string; version: string; files: Record<string, string> }
const templates = new Map<string, PublicationTemplate>();

/** Keep each renderer immutable across process restarts and later Core upgrades. */
async function templateFor(coreCommit: string): Promise<PublicationTemplate> {
  if (!/^[a-f0-9]{40}$/.test(coreCommit)) throw new Error('An immutable Core source commit is required');
  if (templates.has(coreCommit)) return templates.get(coreCommit)!;
  const store = getStore();
  const root = `publishing_templates/${coreCommit}`;
  let metadata = await store.getDoc<{ count: number; digest: string }>(root);
  if (!metadata) {
    if (coreCommit !== process.env.TYPEROLL_SOURCE_SHA) throw new Error('The original publication renderer is unavailable. Restore its frozen template before preparing this publication.');
    const location = process.env.TYPEROLL_PUBLICATION_TEMPLATE || path.resolve(process.cwd(), '../../publication-template.json');
    const text = await fs.readFile(location, 'utf8');
    const count = Math.ceil(text.length / 120000);
    if (count > 200) throw new Error('Publication renderer exceeds the template limit');
    for (let index = 0; index < count; index++) await store.createDocIfMissing(`${root}/chunks/${index}`, { data: text.slice(index * 120000, (index + 1) * 120000) });
    await store.createDocIfMissing(root, { count, digest: digest(text) });
    metadata = (await store.getDoc<{ count: number; digest: string }>(root))!;
  }
  if (!Number.isSafeInteger(metadata.count) || metadata.count < 1 || metadata.count > 200) throw new Error('Invalid frozen renderer');
  let text = '';
  for (let index = 0; index < metadata.count; index++) {
    const chunk = await store.getDoc<{ data: string }>(`${root}/chunks/${index}`);
    if (!chunk) throw new Error('Frozen renderer is incomplete');
    text += chunk.data;
  }
  if (digest(text) !== metadata.digest) throw new Error('Frozen renderer failed integrity verification');
  const template = JSON.parse(text) as PublicationTemplate;
  if (template.format !== 'typeroll-publication-template' || !template.files?.['package-lock.json'] || !template.files?.['scripts/build.mjs']) throw new Error('A frozen Core publication template is required');
  templates.set(coreCommit, template);
  return template;
}

/** No package resolution or Astro build runs on the CMS publication request. */
export async function publicationSourceTree(publication: any): Promise<Record<string, string>> {
  const template = await templateFor(publication.core_commit);
  const files = { ...template.files, 'publication.json': `${JSON.stringify(publication, null, 2)}\n` };
  const manifest = { format_version: 1, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([name, content]) => [name, digest(content)])) };
  return { ...files, 'publication-manifest.json': `${JSON.stringify(manifest, null, 2)}\n` };
}
