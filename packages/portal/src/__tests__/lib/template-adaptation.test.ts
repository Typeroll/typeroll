/**
 * Templates that follow the site, in the portal (plan §5): authored
 * {{site.name}} / {{site.fields.*}} in the preview from render version 15,
 * hard-coded colours flagged when a block template is saved and fixed with
 * the exact replacement, sample text in the site's (or page's) language on
 * import and insert, and placeholders left in live content as a readiness
 * item and a publication warning. Offline; the dev session is 'dev-user' in
 * organization 'default'.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, applyDesignTokenReplacements, paths, type Block, type CollectionEntry, type SitePackage } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { listBlockTemplates } from '../../lib/block-templates-store';
import { importSitePackageIntoVersion, preparePackageImport, serializablePlan } from '../../lib/packages/package-import';
import { insertFromCollection } from '../../lib/collections/collections';
import { readDesignTokenAudit } from '../../lib/design-token-audit';
import { buildSiteReadiness, type ReadinessInput } from '../../lib/site-readiness';
import { publicationPlaceholderWarnings } from '../../lib/placeholder-content';

const ORG = 'default', SITE = 'bistro';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;
type Route = Record<string, APIRoute>;

async function seed(settings: Record<string, unknown> = {}) {
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'Bistro', hosting_adapter: 'cloudflare', created_at: '' });
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '', robots_blocked: false });
  await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'Bistro <Lykta>', language: 'sv', colors: { primary: '#0a6b45', secondary: '#334155', accent: '#f59e0b', background: '#ffffff', surface: '#f8fafc', text: '#111827', text_light: '#6b7280' }, fonts: { heading: 'Inter', body: 'Inter' }, ...settings });
}

async function call(route: Route, method: string, body?: unknown, params: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/sites/${SITE}/x`, { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return route[method]!({ request, cookies, params: { siteId: SITE, ...params }, locals: {} } as never) as Promise<Response>;
}

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

describe('authored site variables in the preview', () => {
  async function preview(renderVersion: number) {
    await seed({ render_version: renderVersion });
    await vstore.writeSiteFields(ORG, SITE, MAIN_VERSION_ID, { groups: [{ id: 'contact', label: 'Contact', fields: [{ name: 'phone', label: 'Phone', type: 'text' }] }], values: { phone: '08-123 <45>' } } as never);
    await getStore().setDoc(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID), { title: 'Home', slug: '', status: 'published', content_mode: 'html', html_content: '<p>Welcome to {{site.name}}, call {{site.fields.phone}}.</p>' });
    const { renderPreview } = await import('../../lib/render-preview');
    return (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
  }
  it('expands {{site.name}} and {{site.fields.*}}, escaped, from render version 15', async () => {
    expect(await preview(15)).toContain('Welcome to Bistro &lt;Lykta&gt;, call 08-123 &lt;45&gt;.');
  });
  it('shows them as written before render version 15', async () => {
    expect(await preview(14)).toContain('Welcome to {{site.name}}, call {{site.fields.phone}}.');
  });
});

describe('design findings when a block template is saved', () => {
  const blocks: Block[] = [{ id: 's1', type: 'core/section', data: { background: '#0a6b45', text_color: '#123456' }, children: [] }];

  it('lists hard-coded colours with the token, and the exact replacement re-saves the template', async () => {
    await seed();
    const index = await import('../../pages/api/sites/[siteId]/block-templates/index') as unknown as Route;
    const created = await call(index, 'POST', { name: 'Hero band', blocks });
    expect(created.status).toBe(201);
    const body = await created.json() as { block_template: { id: string; blocks: Block[] }; design_findings: Array<{ code: string; value: string; suggestions: string[]; replacement?: { after: string; block_id: string; field: string; before: string } }> };
    expect(body.design_findings.map(f => [f.code, f.value])).toEqual([['hardcoded_color', '#0a6b45'], ['hardcoded_color', '#123456']]);
    const exact = body.design_findings[0].replacement!;
    expect(exact).toMatchObject({ block_id: 's1', field: 'background', before: '#0a6b45', after: 'primary', target: { kind: 'block_template', id: body.block_template.id } });
    expect(body.design_findings[1].replacement).toBeUndefined();
    expect(body.design_findings[1].suggestions.length).toBeGreaterThan(0);

    // "Use primary": patch the template's blocks and save it again.
    const one = await import('../../pages/api/sites/[siteId]/block-templates/[templateId]') as unknown as Route;
    const saved = await call(one, 'PATCH', { blocks: applyDesignTokenReplacements(body.block_template.blocks, [exact]) }, { templateId: body.block_template.id });
    expect(saved.status).toBe(200);
    const after = await saved.json() as { block_template: { blocks: Block[] }; design_findings: Array<{ value: string }> };
    expect(after.block_template.blocks[0].data.background).toBe('primary');
    expect(after.design_findings.map(f => f.value)).toEqual(['#123456']);
  });

  it('answers the v1 API the same way and lint_design_tokens covers block templates', async () => {
    await seed();
    const { createApiKey } = await import('../../lib/api-keys');
    const token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'k', createdBy: 'a@example.com' })).token;
    const v1 = await import('../../pages/api/v1/sites/[siteId]/block-templates/index') as unknown as Route;
    const res = await v1.POST!({ request: new Request(`http://localhost/api/v1/sites/${SITE}/block-templates`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Band', blocks }) }), params: { siteId: SITE }, cookies, locals: {} } as never) as Response;
    expect(res.status).toBe(201);
    expect(((await res.json()) as { design_findings: unknown[] }).design_findings).toHaveLength(2);
    const audit = await readDesignTokenAudit(ORG, SITE, MAIN_VERSION_ID);
    expect(audit.findings.filter(f => f.source.startsWith('block_template:'))).toHaveLength(2);
    expect(audit.exact_replacements.some(r => r.target.kind === 'block_template')).toBe(true);
  });
});

describe('sample text in the site\'s language', () => {
  const tree = (text: string): Block[] => [{ id: 'p', type: 'core/prose', data: { html: `<p>${text}</p>` } }];
  const pkg = (): SitePackage => ({
    format: 'typeroll-package', format_version: 1, kind: 'collection', id: 'starter', name: 'Starter', version: '1', created_at: '2026-11-07T00:00:00Z',
    contents: {
      block_templates: [{ id: 'welcome', name: 'Welcome', kind: 'section', blocks: tree('Hello'), translations: { sv: { name: 'Välkommen', blocks: tree('Hej') } } }],
      page_templates: [{ id: 'landing', name: 'landing', label: 'Landing', applies_to: 'any', blocks: tree('Landing'), translations: { 'sv-SE': { label: 'Landningssida', blocks: tree('Landning') } } }],
    },
    media: [], integrity: { algorithm: 'sha256', files: {} },
  } as unknown as SitePackage);

  it('imports one language per template, the site\'s, and says which', async () => {
    await seed();
    const ctx = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };
    const prepared = await preparePackageImport(ctx, { manifest: pkg(), files: new Map() }, { design: 'content' });
    expect(serializablePlan(prepared).template_languages).toEqual([
      { section: 'block_templates', id: 'welcome', language: 'sv', available: ['sv'] },
      { section: 'page_templates', id: 'landing', language: 'sv-SE', available: ['sv-SE'] },
    ]);
    const report = await importSitePackageIntoVersion({ ...ctx, permission: 'admin', design: true, actor: 'test' }, prepared);
    expect(report.template_languages.map(entry => entry.language)).toEqual(['sv', 'sv-SE']);
    const [stored] = await listBlockTemplates({ orgId: ORG, siteId: SITE });
    expect(stored).toMatchObject({ name: 'Välkommen' });
    expect(JSON.stringify(stored.blocks)).toContain('Hej');
    expect(stored).not.toHaveProperty('translations');
    const page = await vstore.pageTemplate(ORG, SITE, MAIN_VERSION_ID, 'landing');
    expect(page?.label).toBe('Landningssida');
    expect(JSON.stringify(page?.blocks)).toContain('Landning');
  });

  it('keeps the template\'s own text for a site in another language', async () => {
    await seed({ language: 'de' });
    const prepared = await preparePackageImport({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, { manifest: pkg(), files: new Map() }, { design: 'content' });
    expect(prepared.templateLanguages.map(entry => entry.language)).toEqual([null, null]);
    expect(JSON.stringify(prepared.pkg.contents.block_templates)).toContain('Hello');
  });

  it('places a collection entry in the page\'s language when the page has one', async () => {
    await seed();
    await getStore().setDoc(paths.page(ORG, SITE, 'about-en', MAIN_VERSION_ID), { title: 'About', slug: 'about', status: 'draft', content_mode: 'blocks', language: 'en', blocks: [] });
    await getStore().setDoc(paths.page(ORG, SITE, 'om', MAIN_VERSION_ID), { title: 'Om oss', slug: 'om', status: 'draft', content_mode: 'blocks', blocks: [] });
    const entry = { id: 'e1', kind: 'section', name: 'Welcome', package: { ...pkg(), contents: { block_templates: pkg().contents.block_templates } }, source: { type: 'builtin' }, created_by: 't', created_at: '', updated_at: '' } as unknown as CollectionEntry;
    const ctx = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, permission: 'admin' as const, design: true, actor: 'test' };
    const english = await insertFromCollection(ctx, entry, { target: 'page', page_id: 'about-en' });
    expect(JSON.stringify(english.page?.blocks)).toContain('Hello');
    const swedish = await insertFromCollection(ctx, entry, { target: 'page', page_id: 'om' });
    expect(JSON.stringify(swedish.page?.blocks)).toContain('Hej');
    expect(swedish.report.template_languages).toEqual([{ section: 'block_templates', id: 'welcome', language: 'sv', available: ['sv'] }]);
  });
});

describe('placeholders left in content', () => {
  const page = (id: string, html: string, status = 'published') => ({ id, title: id, slug: id, path: `/${id}`, status, content_type: 'page', content_mode: 'blocks', blocks: [{ id: 'p', type: 'core/prose', data: { html } }] });
  const input = (pages: unknown[], partials: unknown[] = []): ReadinessInput => ({
    siteId: SITE, settings: { site_name: 'Bistro', language: 'sv' } as never, pages: pages as never, partials: partials as never, templates: [], contentTypes: [], blockTypes: [],
    media: [], apps: null, links: { links: [] }, zone: { status: 'unavailable' } as never,
  });

  it('is a readiness warning listing live pages and global blocks, with editor links', () => {
    const report = buildSiteReadiness(input(
      [page('features', '<p>[Feature name] makes [Benefit] easy.</p>'), page('draft', '<p>[Draft only]</p>', 'draft'), page('done', '<p>See [the docs](https://x).</p>')],
      [{ id: 'footer', name: 'Footer', kind: 'footer', status: 'published', content_mode: 'blocks', blocks: [{ id: 'f', type: 'core/prose', data: { html: '<p>[Company name]</p>' } }] }],
    ));
    const item = report.items.find(entry => entry.id === 'placeholders')!;
    expect(item).toMatchObject({ status: 'warning', details: ['features (/features): [Feature name], [Benefit]', 'Global block Footer: [Company name]'] });
    expect(item.links).toEqual([{ label: 'features', href: `/app/sites/${SITE}/pages/features` }, { label: 'Footer', href: `/app/sites/${SITE}/partials/footer` }]);
    expect(item.guide).toMatch(/#placeholders$/);
    expect(buildSiteReadiness(input([page('done', '<p>Real text</p>')])).items.find(entry => entry.id === 'placeholders')!.status).toBe('ok');
  });

  it('is a publication warning naming a few examples', () => {
    const [warning] = publicationPlaceholderWarnings({ pages: [page('features', '<p>[Feature name]</p>')] });
    expect(warning).toContain('"[Feature name]" is still on 1 page');
    expect(warning).toContain('features (/features): [Feature name]');
    expect(publicationPlaceholderWarnings({ pages: [page('done', '<p>Done</p>')] })).toEqual([]);
  });
});
