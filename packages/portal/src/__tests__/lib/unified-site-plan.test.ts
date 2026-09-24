import { describe, it, expect } from 'vitest';
import { planUnifiedSiteMigration, siteDocumentHash, type SiteDocuments } from '../../lib/migrations/unified-site-plan';

function source(): SiteDocuments {
  return {
    'versions/main': { name: 'Main', kind: 'main' },
    'versions/draft': { name: 'Draft', kind: 'branch', base_version_id: 'main' },
    'versions/main/pages/about': { title: 'About', slug: 'about', content_mode: 'html', html_content: '<p>About</p>', status: 'published' },
    'versions/main/collections/articles': { name: 'articles', label_singular: 'Article', label_plural: 'Articles', route_template: '/articles/{slug}', fields: [{ name: 'body', label: 'Body', type: 'richtext' }, { name: 'related', label: 'Related', type: 'item_ref', ref_collection: 'articles' }] },
    'versions/main/collections/articles/items/about': { title: 'Article', slug: 'one', body: '<h2 id="old">One</h2>', status: 'published', related: 'next' },
    'versions/main/collections/articles/items/next': { title: 'Next', slug: 'next', body: '<p>Next</p>', status: 'published' },
    'versions/draft/_tombstones_collection-items:articles/next': { deleted: true },
    'versions/main/collections/articles/items/about/revisions/first': { kind: 'item', resource_id: 'articles/about', created_by: 'editor', doc: { title: 'Previous title', slug: 'one', body: '<p>Earlier content</p>', status: 'published' } },
    'versions/draft/working_copies/item--articles--about': { kind: 'item', target_id: 'about', collection: 'articles', updated_at: '2026-01-01', fields: { title: 'Unsaved title', body: '<p>Unsaved body</p>' } },
    'edit_grants/grant': { collection: 'articles', item_id: 'about', email: 'test@example.test', token_hash: 'test-hash', expires_at: '2026-01-02' },
  };
}

describe('offline unified site migration plan', () => {
  it('is deterministic, preserves the source and converts all current records', () => {
    const input = source(), original = structuredClone(input);
    const plan = planUnifiedSiteMigration(input, '2026-01-01');
    expect(input).toEqual(original);
    expect(plan.source_hash).toBe(siteDocumentHash(input));
    expect(plan.result_hash).toBe(siteDocumentHash(plan.documents));
    expect(plan).toEqual(planUnifiedSiteMigration(input, '2026-01-01'));
    expect(plan.versions).toMatchObject([{ id: 'main', pages: 3 }, { id: 'draft', pages: 2 }]);
    expect(Object.keys(plan.documents).some(path => path.includes('/collections/'))).toBe(false);
    expect(plan.documents['versions/main/pages/about']).toMatchObject({ content_type: 'page', content_mode: 'html', path: '/about', html_content: '<p>About</p>' });
  });
  it('retains inheritance and migrates branch deletions rather than resurrecting records', () => {
    const plan = planUnifiedSiteMigration(source(), '2026-01-01');
    expect(plan.documents['versions/draft/pages/about']).toBeUndefined();
    expect(plan.documents['versions/draft/_tombstones_pages/next']).toMatchObject({ deleted: true });
    expect(plan.documents['versions/draft/content_types/articles']).toBeUndefined();
    expect(plan.documents['versions/main/content_types/articles']).toMatchObject({ fields: [{ name: 'related', type: 'page_ref', ref_content_type: 'articles' }] });
  });
  it('rekeys revisions, working copies and edit grants to the same global Page identity', () => {
    const plan = planUnifiedSiteMigration(source(), '2026-01-01');
    const id = plan.mappings.find(mapping => mapping.item === 'about')!.page;
    expect(id).not.toBe('about');
    expect(plan.documents[`versions/main/pages/${id}/revisions/first`]).toMatchObject({ kind: 'page', resource_id: id, created_by: 'editor', doc: { title: 'Previous title', content_mode: 'html', html_content: '<p>Earlier content</p>' } });
    expect(plan.documents[`versions/draft/working_copies/page--${id}`]).toMatchObject({ kind: 'page', target_id: id, fields: { title: 'Unsaved title', html_content: '<p>Unsaved body</p>' } });
    expect(plan.documents[`versions/draft/working_copies/page--${id}`]).not.toHaveProperty('collection');
    expect(plan.documents['edit_grants/grant']).toMatchObject({ content_type: 'articles', page_id: id, token_hash: 'test-hash' });
  });
  it('reserves IDs from deleted records whose history still exists', () => {
    const input = source();
    input['versions/main/pages/next/revisions/old'] = { kind: 'page', resource_id: 'next', doc: { title: 'Removed page', slug: 'removed', status: 'draft', content_mode: 'html', html_content: '<p>Old</p>' } };
    const plan = planUnifiedSiteMigration(input, '2026-01-01');
    const id = plan.mappings.find(mapping => mapping.item === 'next')!.page;
    expect(id).not.toBe('next');
    expect(plan.documents[`versions/draft/_tombstones_pages/${id}`]).toMatchObject({ deleted: true });
    expect(plan.documents['versions/main/pages/next/revisions/old']).toMatchObject({ doc: { title: 'Removed page', content_type: 'page' } });
  });
  it('rejects unknown child data and cyclic branches before any write', () => {
    const input = source(); input['versions/main/collections/articles/items/about/unknown/data'] = { must_keep: true };
    expect(() => planUnifiedSiteMigration(input, '2026-01-01')).toThrow('Unsupported item subdocument');
    const cycle = source(); cycle['versions/draft'].base_version_id = 'draft';
    expect(() => planUnifiedSiteMigration(cycle, '2026-01-01')).toThrow('inheritance cycle');
  });
  it('refuses to run a second conversion on an already migrated site', () => {
    const plan = planUnifiedSiteMigration(source(), '2026-01-01');
    expect(() => planUnifiedSiteMigration(plan.documents, '2026-01-01')).toThrow('already uses unified Pages');
  });
});

it('migrates shared blocks, form steps, directory settings and scoped edit permissions', () => {
  const input = source();
  const listing = [{ id: 'list', type: 'core/collection_list', data: { collection: 'articles', source_type: 'collection' } }];
  input['versions/main/partials/sidebar'] = { name: 'Sidebar', kind: 'free', status: 'published', content_mode: 'blocks', blocks: listing };
  input['versions/main/partials/sidebar/revisions/old'] = { kind: 'partial', doc: { name: 'Sidebar', content_mode: 'blocks', blocks: listing } };
  input['forms/contact'] = { name: 'Contact', steps: [{ id: 'first', blocks: listing }], actions: [{ type: 'email', config: { private_key: 'synthetic-do-not-change' } }] };
  input['apps/default'] = { apps: { directory: { enabled: true, config: { collection: 'articles', email_field: 'email' } } } };
  input['extension_installations/one'] = { scopes: ['collections:read', 'content:read', 'collections:write'] };
  const type = input['versions/main/collections/articles'];
  (type.fields as unknown[]).push({ name: 'title', label: 'Name', type: 'text', writable_by: ['owner', 'portal'] });
  type.item_template_blocks = [{ id: 'if', type: 'template/show_if', data: { condition: 'item.title != "item.keep_literal"' }, children: [{ id: 'body', type: 'template/item_body', data: {} }] }];
  const plan = planUnifiedSiteMigration(input, '2026-01-01');
  expect(plan.documents['versions/main/partials/sidebar']).toMatchObject({ blocks: [{ type: 'core/page_list', data: { content_type: 'articles', source_type: 'pages' } }] });
  expect(plan.documents['versions/main/partials/sidebar/revisions/old']).toMatchObject({ doc: { blocks: [{ type: 'core/page_list' }] } });
  expect(plan.documents['forms/contact']).toMatchObject({ steps: [{ blocks: [{ type: 'core/page_list' }] }], actions: input['forms/contact'].actions });
  expect(plan.documents['apps/default']).toMatchObject({ apps: { directory: { config: { content_type: 'articles' } } } });
  expect(JSON.stringify(plan.documents['apps/default'])).not.toContain('collection');
  expect(plan.documents['extension_installations/one'].scopes).toEqual(['content:read', 'content:write']);
  expect(plan.documents['versions/main/content_types/articles']).toMatchObject({ page_field_rules: { title: { writable_by: ['owner', 'portal'] } } });
  const template = Object.entries(plan.documents).find(([path]) => path.startsWith('versions/main/page_templates/'))![1];
  expect((template.blocks as any[])[0].data.condition).toBe('page.title != "item.keep_literal"');
});

it('plans image blocks in the exact persisted JSON shape without absent dimensions', () => {
  const input = source();
  input['versions/main/pages/about'].html_content = '<p>Before</p><img src="https://media.example.test/photo.jpg" alt="Photo"><p>After</p>';
  const result = planUnifiedSiteMigration(input, '2026-01-01').documents;
  expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)));
  const page = result['versions/main/pages/about'];
  expect(JSON.stringify(page)).toContain('https://media.example.test/photo.jpg');
});
