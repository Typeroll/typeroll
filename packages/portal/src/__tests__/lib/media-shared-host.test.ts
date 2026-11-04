// Images served from the organization media host leave the Pages deployment:
// website-hosted images of earlier publications move to their organization-host
// keys, one redirect per website media path keeps old addresses working, and
// publication verification treats those addresses as moved, not deleted.
import { describe, expect, it } from 'vitest';
import { moveWebsiteMediaToMediaHost, collapseMediaHostChains } from '../../lib/publishing/media-manifest';
import { staticManifestChecks } from '../../lib/builds/verification';

const storage = { account_id: 'a'.repeat(32), original_bucket: 'private', public_bucket: 'public', site_prefix: 'media/abcdefghij' };
const current = { ...storage, delivery: 'r2', media_host: 'media.example.net', website_host: 'www.example.com', media_path_prefix: '/media/abcdefghij',
  entries: [{ id: 'new', public_path: '/media/abcdefghij/new.png', public_key: 'media/abcdefghij/new.png', aliases: [] }] };
const staticManifest = { ...storage, delivery: 'static', media_host: 'www.example.com', website_host: 'www.example.com', media_path_prefix: '/media',
  entries: [
    { id: 'kept', public_path: '/media/1111-photo.png', public_key: 'media/abcdefghij/media/1111-photo.png',
      aliases: [{ url: 'https://media.example.net/media/abcdefghij/1111-photo.png', key: 'media/abcdefghij/1111-photo.png' }] },
    { id: 'old', public_path: '/media/2222-early.png', public_key: 'media/abcdefghij/media/2222-early.png', aliases: [] },
  ] };

describe('moveWebsiteMediaToMediaHost', () => {
  it('moves website-hosted media to the organization host and redirects its path', () => {
    const { retained, redirects } = moveWebsiteMediaToMediaHost([staticManifest], current);
    expect(retained[0]).toMatchObject({ delivery: 'r2', media_host: 'media.example.net', static_path_prefix: '/media' });
    // An entry with its organization copy is unchanged; one from before gets that copy.
    expect(retained[0].entries[0]).toBe(staticManifest.entries[0]);
    expect(retained[0].entries[1].aliases).toEqual([{ url: 'https://media.example.net/media/abcdefghij/2222-early.png', key: 'media/abcdefghij/2222-early.png' }]);
    expect(redirects).toEqual([expect.objectContaining({ from_path: '/media/*', to_path: 'https://media.example.net/media/abcdefghij/:splat', status_code: 301 })]);
    // The moved manifest keeps its redirect in later publications.
    const again = moveWebsiteMediaToMediaHost(retained, current);
    expect(again.retained).toEqual(retained);
    expect(again.redirects).toEqual(redirects);
  });

  it('moves website-hosted media to a site media host at the same storage keys', () => {
    const own = { ...current, media_host: 'images.example.com', media_path_prefix: '',
      entries: [{ id: 'new', public_path: '/new.png', public_key: 'media/abcdefghij/new.png', aliases: [] }] };
    const { retained, redirects } = moveWebsiteMediaToMediaHost([staticManifest], own);
    expect(retained[0]).toMatchObject({ delivery: 'r2', media_host: 'images.example.com', static_path_prefix: '/media' });
    expect(retained[0].entries[1].aliases).toEqual([{ url: 'https://images.example.com/2222-early.png', key: 'media/abcdefghij/2222-early.png' }]);
    expect(redirects).toEqual([expect.objectContaining({ from_path: '/media/*', to_path: 'https://images.example.com/:splat', status_code: 301 })]);
    // Media that already moved to the shared host now redirects to the site host.
    const moved = moveWebsiteMediaToMediaHost([staticManifest], current).retained;
    expect(moveWebsiteMediaToMediaHost(moved, own).redirects).toEqual(redirects);
  });

  it('changes nothing while the current publication serves media from the website', () => {
    const website = { ...current, delivery: 'static', media_host: 'www.example.com', media_path_prefix: '/media' };
    expect(moveWebsiteMediaToMediaHost([staticManifest], website)).toEqual({ retained: [staticManifest], redirects: [] });
  });

  it('keeps a manifest static when its addresses cannot be redirected as one path', () => {
    const root = { ...staticManifest, media_path_prefix: '' };
    const otherStorage = { ...staticManifest, public_bucket: 'other' };
    const outside = { ...staticManifest, entries: [{ ...staticManifest.entries[0], public_path: '/elsewhere/a.png' }] };
    const { retained, redirects } = moveWebsiteMediaToMediaHost([root, otherStorage, outside], current);
    expect(retained).toEqual([root, otherStorage, outside]);
    expect(redirects).toEqual([]);
  });
});

describe('verification of moved media', () => {
  it('expects redirected media paths to move, and other removed files to be gone', () => {
    const previous = [
      { route: '/media/1111-photo.png', status: 200 as const, sha256: 'a' },
      { route: '/media/1111-photo.png.w640.v2.0123456789abcdef.avif', status: 200 as const, sha256: 'b' },
      { route: '/old-page', status: 200 as const, sha256: 'c' },
    ];
    const checks = staticManifestChecks({ 'index.html': { sha256: 'd' } }, '/media/* https://media.example.net/media/abcdefghij/:splat 301\n', previous);
    expect(checks.map(check => [check.route, check.status])).toEqual([['/', 200], ['/old-page', 404]]);
  });
});

describe('collapseMediaHostChains', () => {
  const hostRules = [{ id: 'media-host-x', media_path_prefix: '/media', from_path: '/media/*', to_path: 'https://media.example.com/site123/:splat', status_code: 301 as const }];
  it('sends old file addresses to the media host in one hop (AT-08)', () => {
    const rules = [
      { id: 'a', from_path: '/wp-content/uploads/2023/a.jpg', to_path: '/media/abc-a.jpg', status_code: 301 as const },
      { id: 'b', from_path: '/wp-content/uploads/b.jpg', to_path: 'https://www.example.com/media/b.jpg', status_code: 301 as const },
      { id: 'c', from_path: '/files/*', to_path: '/media/:splat', status_code: 301 as const },
      { id: 'd', from_path: '/old-page', to_path: '/new-page/', status_code: 301 as const },
      { id: 'e', from_path: '/elsewhere', to_path: 'https://other.example/media/x.jpg', status_code: 301 as const },
    ];
    expect(collapseMediaHostChains(rules, hostRules, 'www.example.com').map(rule => rule.to_path)).toEqual([
      'https://media.example.com/site123/abc-a.jpg', 'https://media.example.com/site123/b.jpg', 'https://media.example.com/site123/:splat', '/new-page/', 'https://other.example/media/x.jpg']);
    // The authored rules are not changed.
    expect(rules[0]!.to_path).toBe('/media/abc-a.jpg');
  });
  it('changes nothing without a media-host move', () => {
    const rules = [{ id: 'a', from_path: '/x', to_path: '/media/x.jpg', status_code: 301 as const }];
    expect(collapseMediaHostChains(rules, [], 'www.example.com')).toBe(rules);
  });
});
