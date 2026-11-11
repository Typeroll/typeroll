import { ConnectionError } from './connections';
import { pagesRedirectsFile } from '@typeroll/shared';
import { publicationContentFiles, stableJson } from '../../../../../scripts/fixtures/static-publication/content.mjs';
import { mapPublicationParts } from './parallel';
import { digest } from './providers.mjs';
import { getStore } from '../datastore';

interface PublicationTemplate { format: string; version: string; files: Record<string, string> }
const templates = new Map<string, PublicationTemplate>();

/**
 * Reads this release's frozen renderer (scripts/build-static-publication-template.mjs).
 * The Worker registers a loader that reads its static asset through ASSETS;
 * local tooling falls back to the file in the repository.
 */
let loadBundledTemplate: () => Promise<string> = async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return fs.readFile(process.env.TYPEROLL_PUBLICATION_TEMPLATE || path.resolve(process.cwd(), '../../publication-template.json'), 'utf8');
};

export function setPublicationTemplateLoader(loader: () => Promise<string>): void {
  loadBundledTemplate = loader;
}

/** Keep each renderer immutable across process restarts and later Core upgrades. */
async function templateFor(coreCommit: string): Promise<PublicationTemplate> {
  if (!/^[a-f0-9]{40}$/.test(coreCommit)) throw new Error('An immutable Core source commit is required');
  if (templates.has(coreCommit)) return templates.get(coreCommit)!;
  const store = getStore();
  const root = `publishing_templates/${coreCommit}`;
  let metadata = await store.getDoc<{ count: number; digest: string }>(root);
  if (!metadata) {
    // Only the Worker release built from this commit can store its renderer. During a gradual
    // rollout another release can pick up the next step of a job the new one froze (moveria-de,
    // 2026-11-11): that is a passing condition, and the runner waits and retries it.
    if (coreCommit !== process.env.TYPEROLL_SOURCE_SHA) throw new ConnectionError('The original publication renderer is unavailable on this Typeroll release, usually while Typeroll is being updated. Retry publishing in a few minutes; the live site is unchanged.', 503, 'publication_renderer_unavailable', { retryable: true });
    const text = await loadBundledTemplate();
    const count = Math.ceil(text.length / 120000);
    if (count > 200) throw new Error('Publication renderer exceeds the template limit');
    await mapPublicationParts(Array.from({ length: count }, (_, i) => i), index => store.createDocIfMissing(`${root}/chunks/${index}`, { data: text.slice(index * 120000, (index + 1) * 120000) }));
    await store.createDocIfMissing(root, { count, digest: digest(text) });
    metadata = (await store.getDoc<{ count: number; digest: string }>(root))!;
  }
  if (!Number.isSafeInteger(metadata.count) || metadata.count < 1 || metadata.count > 200) throw new Error('Invalid frozen renderer');
  const parts = await mapPublicationParts(Array.from({ length: metadata.count }, (_, i) => i), async index => {
    const chunk = await store.getDoc<{ data: string }>(`${root}/chunks/${index}`);
    if (!chunk) throw new Error('Frozen renderer is incomplete');
    return chunk.data;
  });
  const text = parts.join('');
  if (digest(text) !== metadata.digest) throw new Error('Frozen renderer failed integrity verification');
  const template = JSON.parse(text) as PublicationTemplate;
  if (template.format !== 'typeroll-publication-template' || !template.files?.['package-lock.json'] || !template.files?.['scripts/build.mjs']) throw new Error('A frozen Core publication template is required');
  templates.set(coreCommit, template);
  return template;
}

/**
 * Store this release's renderer before a publication frozen with it is
 * saved. Every later step reads the renderer by commit from the datastore, so
 * any Worker release, including an older one still serving part of a gradual
 * rollout, can continue the job. Before, the renderer was stored on first use,
 * after the source was already frozen.
 */
export async function freezePublicationRenderer(coreCommit: string): Promise<void> {
  await templateFor(coreCommit);
}

/** No package resolution or Astro build runs on the CMS publication request. */
export async function publicationSourceTree(publication: any): Promise<Record<string, string>> {
  // The dry-run path reaches this before pushing any source or starting a build.
  try { pagesRedirectsFile(publication.redirects ?? [], publication.settings, publication.site); }
  catch (error) { throw new ConnectionError(error instanceof Error ? error.message : 'Invalid publication redirects.', 409, 'publication_redirect_limit'); }
  const template = await templateFor(publication.core_commit);
  const content = template.files['scripts/content.mjs'] ? publicationContentFiles(publication) : { 'publication.json': stableJson(publication) };
  const files = { ...template.files, ...content };
  const manifest = { format_version: 1, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([name, content]) => [name, digest(content)])) };
  return { ...files, 'publication-manifest.json': `${JSON.stringify(manifest, null, 2)}\n` };
}
