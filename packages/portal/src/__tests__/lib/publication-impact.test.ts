import { expect, it } from 'vitest';
import { captureImpact, compareImpact, legacyBaseline, withImpactOrigins } from '../../lib/publishing/impact';
import { digest } from '../../lib/publishing/providers.mjs';

const page = (id: string) => ({ id, title: id, status: 'published', html_content: `<p>${id}</p>`, date_updated: '2026-01-01' });
const source = () => ({ version_id: 'main', core_commit: 'a'.repeat(40), pages: [page('one'), page('two')], settings: {}, contentTypes: [] as any[] });
const snapshot = (value: any) => captureImpact(value, 'org', 'site');

it('identifies a page body change without promising any output reuse', () => {
  const before = source(), after = source(); after.pages[0].html_content = '<p>Changed</p>';
  expect(compareImpact(snapshot(before), snapshot(after))).toMatchObject({ comparison: 'verified_snapshot', classification: 'page_content_only', changed_pages: 1, total: 1, execution: 'automatic', reuse_verified: false, changes: [{ id: 'one', fields: ['html_content'], action: 'changed' }] });
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
// Six Moveria sites answered total 0 without a baseline although 33–168 pages had been saved (2026-11-11).
it('says the changes are unknown, not none, when there is no baseline, and why', () => {
  const current = snapshot(source());
  const missing = compareImpact(null, current, true, 'not_published');
  expect(missing).toMatchObject({ comparison: 'baseline_unavailable', changes_known: false, classification: 'unknown', total: 0, changes: [],
    baseline: { state: 'unavailable', reason: 'not_published', message: expect.stringContaining('changes are unknown, not none') } });
  expect(missing.baseline).toMatchObject({ message: expect.stringContaining('Publish once to record a baseline') });
  expect(compareImpact({ ...current, site_id: 'other' }, current).baseline).toMatchObject({ reason: 'baseline_identity_mismatch' });
  expect(compareImpact({ ...current, protocol: 1 as any }, current).baseline).toMatchObject({ reason: 'snapshot_without_source_baseline' });
  expect(compareImpact(current, current)).toMatchObject({ comparison: 'verified_snapshot', changes_known: true, baseline: { state: 'verified' }, total: 0, classification: 'none' });
});
it('replaces only the publication addresses of a fingerprint for a domain change', () => {
  const before = { ...source(), impact_origins: { website: 'https://old.example.com', media: null } };
  const after = { ...before, impact_origins: { website: 'https://new.example.com', media: null } };
  const moved = withImpactOrigins(snapshot(before), after.impact_origins);
  expect(moved).toEqual(snapshot(after));
  expect(compareImpact(moved, snapshot(after))).toMatchObject({ total: 0, classification: 'none' });
  expect(compareImpact(snapshot(before), moved)).toMatchObject({ total: 1, changes: [{ kind: 'configuration', id: 'impact_origins' }] });
});
it('widens shared definitions, query membership, origins and toolchain changes', () => {
  const before = source();
  for (const extra of [{ core_commit: 'b'.repeat(40) }, { settings: { sitewide_noindex: true } }, { contentTypes: [{ id: 'news', name: 'news', fields: [] }] }, { impact_origins: { media: 'https://media.example.com' } }, { blockTypes: [{ id: 'shared', template: 'changed' }] }]) {
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

it('uses safe labels for malformed Page titles', () => {
  const input = { ...source(), pages: [{ id: 'article', content_type: 'news', title: { en: 'Article' }, status: 'published' }] };
  expect(snapshot(input).entries.find(entry => entry.id === 'article')?.title).toBe('article');
});

// Core 0.3.27 raised the Extension runtime 0.45.0 → 0.46.0; every Moveria site showed configuration/extensions
// changed, also moveria-it with no installations (2026-11-11).
const runtime = (version: string, installations: any[] = []) => ({ runtime_version: version, protocol_version: 1, installations });
const installation = { installation_id: 'inst', extension_id: 'se.vendor.events', version: '1.0.0', public_config: {}, components: [] };
it('reports a platform version change apart from the site changes, and only as affecting output with installations', () => {
  const without = compareImpact(snapshot({ ...source(), extensions: runtime('0.45.0') }), snapshot({ ...source(), extensions: runtime('0.46.0') }));
  expect(without).toMatchObject({ total: 0, changes: [], classification: 'none',
    platform_changes: [{ id: 'extension_runtime', before: '0.45.0 (protocol 1)', after: '0.46.0 (protocol 1)', affects_output: false }] });
  expect(without.reasons).not.toContain('extension_runtime_changed');
  const withInstallations = compareImpact(snapshot({ ...source(), extensions: runtime('0.45.0', [installation]) }), snapshot({ ...source(), extensions: runtime('0.46.0', [installation]) }));
  expect(withInstallations).toMatchObject({ total: 0, classification: 'site_wide', platform_changes: [{ id: 'extension_runtime', affects_output: true }] });
  expect(withInstallations.reasons).toContain('extension_runtime_changed');
  const core = compareImpact(snapshot(source()), snapshot({ ...source(), core_commit: 'b'.repeat(40) }));
  expect(core).toMatchObject({ total: 0, platform_changes: [{ id: 'core_commit', before: 'a'.repeat(40), after: 'b'.repeat(40), affects_output: true }] });
  expect(core.reasons).toContain('toolchain_changed');
  // An installation the site added is a site change.
  expect(compareImpact(snapshot({ ...source(), extensions: runtime('0.46.0') }), snapshot({ ...source(), extensions: runtime('0.46.0', [installation]) })))
    .toMatchObject({ total: 1, changes: [{ kind: 'configuration', id: 'extensions' }], platform_changes: [] });
});

it('reads a baseline captured before platform versions were recorded without a spurious extensions change', () => {
  const before = { ...source(), extensions: runtime('0.45.0') };
  const after = { ...source(), extensions: runtime('0.46.0') };
  // What Core 0.3.27 and earlier recorded: extensions hashed whole, runtime versions included, no platform field.
  const old = snapshot(before);
  const legacyEntries = old.entries.map(entry => entry.kind === 'configuration' && entry.id === 'extensions'
    ? { ...entry, fields: { ...entry.fields, value: digest(JSON.stringify({ installations: [], protocol_version: 1, runtime_version: '0.45.0' })) } } : entry);
  const legacy = { ...old, entries: legacyEntries, platform: undefined };
  expect(compareImpact(legacy, snapshot(after)).changes).toEqual([expect.objectContaining({ id: 'extensions' })]);
  const read = compareImpact(legacy, snapshot(after), false, null, legacyBaseline(before, after));
  expect(read).toMatchObject({ total: 0, changes: [], platform_changes: [{ id: 'extension_runtime', before: '0.45.0 (protocol 1)', after: '0.46.0 (protocol 1)', affects_output: false }] });
  // Installations that did change still show.
  const added = { ...source(), extensions: runtime('0.46.0', [installation]) };
  expect(compareImpact(legacy, snapshot(added), false, null, legacyBaseline(before, added)).changes).toEqual([expect.objectContaining({ id: 'extensions' })]);
});
