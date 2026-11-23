import { expect, it } from 'vitest';
import { pagesRedirectCapacity, pagesRedirectsFile, type Redirect } from '@typeroll/shared';
import { mediaPathRedirects } from '../../lib/publishing/media-path-redirects';
import { freezeMediaRedirects } from '../../lib/publishing/media-redirect-policy';
import { authoredMediaContent } from '../../lib/publishing/media-manifest';
const base = 'https://media.example.test/media/site';
const wp = '/wp-content/uploads';
const entry = (id = 'a', file = 'photo.jpg') => ({ id, sha256: id.repeat(64), cdn_url: `${base}/2024/05/${file}`, public_path: `/media/site/2024/05/${file}`, aliases: [],
 wordpress_upload: { prefix: wp, path: '/2024/05/photo.jpg', source_path: `${wp}/2024/05/photo.jpg`, declared: true } });
const source = (entries = [entry()]) => ({ site_url: 'https://site.example.test', settings: { trailing_slash: 'always' }, media_manifest: { media_host: 'media.example.test', media_path_prefix: '/media/site', entries } });
const rule = (from_path: string, to_path: string, status_code: 301 | 302 = 301): Redirect => ({ id: `authored-${from_path}`, from_path, to_path, status_code });
it('uses one uploads prefix while dropping wp-content and retaining year and month', () => {
 const result = mediaPathRedirects(source(), []);
 expect(result.generated).toEqual([expect.objectContaining({ from_path: `${wp}/*`, to_path: `${base}/:splat`, status_code: 301 })]);
 expect(pagesRedirectsFile(result.redirects)).toContain(`${wp}/* ${base}/:splat 301`);
});
it('does not declare a namespace merely because a borrowed image came from a WP site', () => {
 const image = entry(); delete (image.wordpress_upload as any).declared;
 expect(mediaPathRedirects(source([image]), []).generated).toEqual([]);
 const authored = rule(image.wordpress_upload.source_path, image.cdn_url);
 expect(mediaPathRedirects(source([image]), [authored]).generated).toHaveLength(1);
});
it('canonicalizes verified same-byte old targets only in the frozen output', () => {
 const old = { ...entry(), cdn_url: 'https://site.example.test/media/hash-photo.jpg' };
 const rules = [rule(`${wp}/2024/05/photo.jpg`, '/media/hash-photo.jpg', 302)];
 const original = structuredClone(rules);
 const result = mediaPathRedirects(source(), rules, [{ entries: [old] }]);
 expect(result.redirects[0]).toEqual({ ...rules[0], to_path: entry().cdn_url });
 expect(rules).toEqual(original);
 // A distinct byte identity cannot authorize changing the old target.
 expect(mediaPathRedirects(source(), rules, [{ entries: [{ ...old, sha256: 'f'.repeat(64) }] }]).redirects[0]).toEqual(rules[0]);
});
it('keeps a numbered collision as an exact exception and respects authored exceptions', () => {
 const image = entry('b', 'photo-2.jpg');
 const result = mediaPathRedirects(source([image]), []);
 expect(result.generated).toHaveLength(2);
 expect(result.generated).toContainEqual(expect.objectContaining({ from_path: `${wp}/2024/05/photo.jpg`, to_path: image.cdn_url }));
 const custom = rule(image.wordpress_upload.source_path, '/owners-choice', 302);
 expect(mediaPathRedirects(source([image]), [custom]).generated).toHaveLength(1);
 expect(mediaPathRedirects(source([image]), [custom]).redirects[0]).toEqual(custom);
});
it('keeps the chosen namespace override and handles collisions under a matching configured namespace', () => {
 const image = entry('b', 'photo-2.jpg');
 const custom = rule(`${wp}/*`, 'https://archive.example.test/:splat', 302);
 expect(mediaPathRedirects(source([image]), [custom])).toEqual({ redirects: [custom], generated: [] });
 const matching = rule(`${wp}/*`, `${base}/:splat`, 302);
 expect(mediaPathRedirects(source([image]), [matching]).generated).toEqual([expect.objectContaining({ from_path: image.wordpress_upload.source_path, to_path: image.cdn_url, status_code: 302 })]);
});
it('compacts thousands of migrated image mappings without losing a collision or changing saved rows', () => {
 const entries = Array.from({ length: 2500 }, (_, n) => ({ ...entry(String(n), `image-${n}.jpg`), wordpress_upload: { prefix: wp, path: `/2024/05/image-${n}.jpg`, source_path: `${wp}/2024/05/image-${n}.jpg` } }));
 const rules = entries.map(item => rule(item.wordpress_upload.source_path, item.cdn_url));
 const result = mediaPathRedirects(source(entries as any), rules);
 const frozen = freezeMediaRedirects(result.redirects);
 expect(frozen.redirects).toHaveLength(1);
 expect(frozen.omitted).toHaveLength(2500);
 expect(pagesRedirectCapacity(frozen.redirects)).toMatchObject({ static: 2, dynamic: 1, bulk_required: false });
 expect(rules).toHaveLength(2500);
});
it('falls back to known exact mappings when the Pages dynamic budget is full', () => {
 const rules = Array.from({ length: 100 }, (_, n) => rule(`/namespace-${n}/*`, `/archive-${n}/:splat`));
 const result = mediaPathRedirects(source(), rules);
 expect(result.generated).toEqual([expect.objectContaining({ from_path: `${wp}/2024/05/photo.jpg`, to_path: entry().cdn_url })]);
 expect(pagesRedirectCapacity(result.redirects).dynamic).toBe(100);
});
it('restores routing history and regenerates the namespace for a later media host', () => {
 const image = entry(), authored = rule(image.wordpress_upload.source_path, image.cdn_url);
 const result = mediaPathRedirects(source(), [authored]);
 const plan = freezeMediaRedirects(result.redirects);
 const frozen = { ...source(), redirects: plan.redirects, media_redirect_omissions: plan.omitted, media_path_redirects: result.generated };
 expect(authoredMediaContent(frozen).redirects).toEqual([authored]);
 const changed = { ...frozen, media_manifest: { ...frozen.media_manifest, media_host: 'new-media.example.test', entries: [{ ...image, cdn_url: image.cdn_url.replace('media.example.test', 'new-media.example.test'), aliases: [{ url: image.cdn_url }] }] } };
 const next = mediaPathRedirects(changed, frozen.redirects);
 expect(next.generated).toHaveLength(1);
 expect(next.generated[0].to_path).toBe('https://new-media.example.test/media/site/:splat');
 expect(freezeMediaRedirects(next.redirects).redirects).toEqual(next.generated);
});

it('uses exact known file mappings when an uploads prefix would hide a page or unknown generated routes', () => {
 for (const routing of [
  { pages: [{ id: 'page', slug: 'wp-content/uploads/help', title: 'Help', status: 'published', content_mode: 'html' }] },
  { pageTemplates: [{ blocks: [{ data: { paginate: 12 } }] }] },
 ]) {
  const result = mediaPathRedirects({ ...source(), ...routing }, []);
  expect(result.generated).toEqual([expect.objectContaining({ from_path: `${wp}/2024/05/photo.jpg`, to_path: entry().cdn_url })]);
 }
});

it('canonicalizes a proven relative file target after the website domain also changes', () => {
 const old = { ...entry(), cdn_url: 'https://old.example.test/media/hash-photo.jpg' };
 const authored = rule(`${wp}/2024/05/photo.jpg`, '/media/hash-photo.jpg');
 expect(mediaPathRedirects(source(), [authored], [{ website_host: 'old.example.test', entries: [old] }]).redirects[0].to_path).toBe(entry().cdn_url);
});
