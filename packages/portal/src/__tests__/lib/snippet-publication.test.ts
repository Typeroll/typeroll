// Live snippets in previews, exports and publications: the preview renders the
// snippets as saved now and names their live files only when the site has a
// live base URL, the export and the frozen publication carry the snippets
// without who wrote them, and the publication lists blocks naming a snippet
// the site does not have.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, SNIPPET_LIVE_SCRIPT } from '@typeroll/shared';
import type { Block, Site, SiteVersion, Snippet } from '@typeroll/shared';
import { publicationSnippetWarnings } from '../../lib/publishing/content-preflight';

const live = vi.hoisted(() => ({ base: null as string | null }));
vi.mock('../../lib/publishing/live-files', () => ({ liveBaseUrl: async () => live.base }));

const ORG = 'orgone';
const SITE = 'snippetsite';
const BASE = 'https://media.example.test/media/m1/live';
const LUNCH: Snippet = {
  id: 'lunch', name: "Today's lunch", kind: 'dated', format: 'html', updated_by: 'person:ada', updated_at: '2026-11-08T08:00:00.000Z',
  // Every weekday has the same lunch, so the preview does not depend on today's date.
  entries: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(weekday => ({ weekday: weekday as never, content: '<p>Pea soup<script>x()</script></p>' })),
};
const BLOCKS: Block[] = [
  { id: 'lunch', type: 'core/snippet', data: { snippet: 'lunch', tag: 'section' } },
  { id: 'gone', type: 'core/snippet', data: { snippet: 'gone', empty_text: 'Nothing yet' } },
];

describe('live snippets in the preview, the export and the publication', () => {
  beforeEach(async () => {
    live.base = null;
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), { name: 'Snippet Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'Snippet Site', language: 'sv', render_version: 15 });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, { title: 'Start', slug: 'home', path: '/', content_mode: 'blocks', status: 'published', blocks: BLOCKS, html_content: '' });
    const { id: _id, ...doc } = LUNCH;
    await store.setDoc(paths.snippet(ORG, SITE, 'lunch'), doc);
  });

  it('renders the snippet as saved, sanitized, without a live file while the site has none', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { allowScripts: true }))!;
    expect(html).toMatch(/<section data-block="snippet"[^>]* data-snippet="lunch" data-format="html" data-updated="2026-11-08T08:00:00.000Z" data-snippet-date="\d{4}-\d{2}-\d{2}"><p>Pea soup<\/p><\/section>/);
    expect(html).not.toContain('x()');
    expect(html).toMatch(/data-snippet="gone" data-empty="true">Nothing yet</);
    expect(html).not.toContain('data-snippet-src');
    expect(html).not.toContain(SNIPPET_LIVE_SCRIPT.slice(0, 60));
  });

  it('names the live file and ships the script when the site has live files', async () => {
    live.base = BASE;
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { allowScripts: true }))!;
    expect(html).toContain(`data-snippet-src="${BASE}/lunch.json"`);
    expect(html).toContain(`data-snippet-src="${BASE}/gone.json"`);
    expect(html).toContain('core/snippet live content');
  });

  it('freezes the snippets and the live base URL with the version, and exports them without who wrote them', async () => {
    live.base = BASE;
    const { resolvePublicationVersion } = await import('../../lib/publishing/publication-version');
    const resolved = await resolvePublicationVersion(ORG, SITE, MAIN_VERSION_ID);
    expect(resolved.snippets.map(snippet => snippet.id)).toEqual(['lunch']);
    expect(resolved.liveBaseUrl).toBe(BASE);
    const { contentSnapshot } = await import('../../lib/export');
    const { getStore } = await import('../../lib/datastore');
    const snapshot = await contentSnapshot(getStore(), ORG, SITE, MAIN_VERSION_ID);
    expect(snapshot.get(paths.snippet(ORG, SITE, 'lunch'))).toMatchObject({ kind: 'dated', updated_at: LUNCH.updated_at });
    expect(snapshot.get(paths.snippet(ORG, SITE, 'lunch'))).not.toHaveProperty('updated_by');
    expect(snapshot.get(paths.site(ORG, SITE))).toMatchObject({ live_base_url: BASE });
  });

  it('warns once per snippet a block names and the site does not have', () => {
    const warnings = publicationSnippetWarnings({
      pages: [{ id: 'home', blocks: BLOCKS }, { id: 'about', blocks: [BLOCKS[1]!, { id: 'none', type: 'core/snippet', data: {} }] }],
      snippets: [{ id: 'lunch' }],
    });
    expect(warnings).toEqual([
      'page home shows the live snippet "gone", which the site does not have; the block shows its empty text or nothing.',
      'page about has a Live snippet block that names no snippet.',
    ]);
  });
});
