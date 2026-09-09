import { expect, it } from 'vitest';
import { captureImpact, compareImpact } from '../../lib/publishing/impact';

const page = (id: string) => ({ id, title: id, status: 'published', html_content: `<p>${id}</p>`, date_updated: '2026-01-01' });
const source = () => ({ version_id: 'main', core_commit: 'a'.repeat(40), pages: [page('one'), page('two')], settings: {}, collections: [] as any[] });
const snapshot = (value: any) => captureImpact(value, 'org', 'site');

it('identifies a page body change without promising any output reuse', () => {
  const before = source(), after = source(); after.pages[0].html_content = '<p>Changed</p>';
  expect(compareImpact(snapshot(before), snapshot(after))).toMatchObject({ comparison: 'verified_snapshot', classification: 'page_content_only', changed_pages: 1, total: 1, execution: 'full', reuse_verified: false, changes: [{ id: 'one', fields: ['html_content'], action: 'changed' }] });
});
it('counts a reverted edit as metadata only while preserving nested customer timestamp fields', () => {
  const before = source(), after = source(); after.pages[0].date_updated = '2026-02-01';
  expect(compareImpact(snapshot(before), snapshot(after))).toMatchObject({ total: 0, metadata_only: 1, classification: 'none' });
  const a = snapshot({ ...before, settings: { custom: { date_updated: 'one' } } });
  const b = snapshot({ ...before, settings: { custom: { date_updated: 'two' } } });
  expect(compareImpact(a, b).classification).toBe('site_wide');
});
it('reports removed and unpublished source pages plus newly published pages', () => {
  const before = source(), after = source(); after.pages = [page('three')];
  expect(compareImpact(snapshot(before), snapshot(after))).toMatchObject({ total: 3, removed_pages: 2, added_pages: 1, classification: 'site_wide' });
});
it('requires the same organization, site and version and a verified source baseline', () => {
  const current = snapshot(source());
  for (const key of ['org_id', 'site_id', 'version_id']) expect(compareImpact({ ...current, [key]: 'other' }, current).comparison).toBe('baseline_unavailable');
  expect(compareImpact(null, current).reasons).toContain('verified_source_baseline_unavailable');
});
it('widens shared definitions, query membership, origins and toolchain changes', () => {
  const before = source();
  for (const extra of [{ core_commit: 'b'.repeat(40) }, { settings: { sitewide_noindex: true } }, { collections: [{ definition: { id: 'news', name: 'news' }, items: [{ id: 'new', title: 'new' }] }] }, { impact_origins: { media: 'https://media.example.com' } }, { blockTypes: [{ id: 'shared', template: 'changed' }] }]) {
    expect(compareImpact(snapshot(before), snapshot({ ...before, ...extra })).classification).toBe('site_wide');
  }
});
it('fingerprints referenced media bytes without exposing storage secrets or unrelated media', () => {
  const input = { ...source(), pages: [{ ...page('one'), html_content: '<img src="https://media.example.com/one.png" />' }] };
  const media = { id: 'photo', cdn_url: 'https://media.example.com/one.png', sha256: 'a'.repeat(64), secret: 'never-in-report' };
  const a = captureImpact(input, 'org', 'site', [media]);
  const b = captureImpact(input, 'org', 'site', [{ ...media, sha256: 'b'.repeat(64) }, { id: 'unused', cdn_url: 'https://media.example.com/unused.png' }]);
  expect(compareImpact(a, b)).toMatchObject({ total: 1, classification: 'site_wide', changes: [{ kind: 'media', id: 'photo' }] });
  expect(JSON.stringify(b)).not.toContain('never-in-report');
  expect(b.entries.some(entry => entry.id === 'unused')).toBe(false);
});
it('canonicalizes object ordering while retaining array order and full counts beyond the response limit', () => {
  expect(compareImpact(snapshot({ ...source(), settings: { a: 1, b: 2 } }), snapshot({ ...source(), settings: { b: 2, a: 1 } })).total).toBe(0);
  const before = source(), after = { ...source(), pages: Array.from({ length: 75 }, (_, i) => page(`new-${i}`)) };
  const result = compareImpact(snapshot(before), snapshot(after));
  expect(result.total).toBe(77); expect(result.changes).toHaveLength(50); expect(result.added_pages).toBe(75);
});

it('uses safe labels for collection items with structured title fields', () => {
  const input = { ...source(), collections: [{ definition: { id: 'news', name: 'news' }, items: [{ id: 'article', title: { en: 'Article' }, name: 42 }] }] };
  expect(snapshot(input).entries.find(entry => entry.id === 'article')?.title).toBe('article');
});
