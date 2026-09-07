import { describe, it, expect } from 'vitest';
import { liveBaseFor, pageLiveUrl, pagePreviewUrl, siteDisplayHost } from '../../lib/site-urls';
import { MAIN_VERSION_ID } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const mainVersion: SiteVersion = {
  id: MAIN_VERSION_ID,
  name: 'Main',
  kind: 'main',
  created_at: '',
  last_deployed_at: '2026-09-07T12:00:00.000Z',
};
const branchVersion = (deploy_url?: string): SiteVersion => ({
  id: 'feat',
  name: 'feat',
  kind: 'branch',
  base_version_id: MAIN_VERSION_ID,
  created_at: '',
  last_deployed_at: '2026-09-07T12:00:00.000Z',
  ...(deploy_url ? { deploy_url } : {}),
});

describe('liveBaseFor', () => {
  it('returns null when main has neither domain nor fallback', () => {
    expect(liveBaseFor({ domain: undefined }, mainVersion)).toBeNull();
  });

  it('prefers domain over fallback', () => {
    expect(liveBaseFor({
      domain: 'example.com',
      hosting_config: { fallback_subdomain: 'foo.sites.example.org' },
    }, mainVersion)).toBe('https://example.com');
  });

  it('falls back to hosting_config.fallback_subdomain when no domain', () => {
    expect(liveBaseFor({
      domain: undefined,
      hosting_config: { fallback_subdomain: 'foo.sites.example.org' },
    }, mainVersion)).toBe('https://foo.sites.example.org');
  });

  it('returns null for a branch without deploy_url', () => {
    expect(liveBaseFor({ domain: 'example.com' }, branchVersion())).toBeNull();
  });

  it('returns the deploy_url for a branch that has one', () => {
    expect(liveBaseFor({ domain: 'example.com' }, branchVersion('https://feat.preview.com/')))
      .toBe('https://feat.preview.com');
  });
});

describe('siteDisplayHost', () => {
  it('returns real domain when set', () => {
    expect(siteDisplayHost({ domain: 'example.com' })).toEqual({ host: 'example.com', isFallback: false });
  });
  it('returns fallback subdomain with marker when domain unset', () => {
    expect(siteDisplayHost({
      domain: undefined,
      hosting_config: { fallback_subdomain: 'foo.sites.example.org' },
    })).toEqual({ host: 'foo.sites.example.org', isFallback: true });
  });
  it('returns null when neither is set', () => {
    expect(siteDisplayHost({ domain: undefined })).toBeNull();
  });
});

describe('pageLiveUrl', () => {
  const site: Site = { id: 's', name: 'x', domain: 'example.com', hosting_adapter: 'cloudflare' } as Site;
  it('returns null for unpublished pages', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'about', status: 'draft' })).toBeNull();
  });
  it('hides configured live links before the first successful deploy', () => {
    expect(pageLiveUrl(site, null, { slug: 'test-page', status: 'published', date_updated: '2026-09-06T12:00:00.000Z' })).toBeNull();
    expect(liveBaseFor(site, { ...mainVersion, last_deployed_at: undefined })).toBeNull();
  });
  it('hides pages created, published or changed after the deployed snapshot', () => {
    const version = { ...mainVersion, last_deployed_content_at: '2026-09-07T11:00:00.000Z' };
    for (const date_updated of ['2026-09-07T11:30:00.000Z', '2026-09-07T13:00:00.000Z', 'invalid', undefined]) {
      expect(pageLiveUrl(site, version, { slug: 'test-page', status: 'published', date_updated })).toBeNull();
    }
    expect(pageLiveUrl(site, version, { slug: 'test-page', status: 'published', date_updated: '2026-09-06T12:00:00.000Z', date_published: '2026-09-07T11:30:00.000Z' })).toBeNull();
  });
  it('shows deployed unlisted pages and honors their explicit path', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'internal', path: '/guides/internal/', status: 'unlisted', date_updated: '2026-09-06T12:00:00.000Z' })).toBe('https://example.com/guides/internal');
  });
  it('does not substitute the production domain for an undeployed branch', () => {
    expect(pageLiveUrl(site, branchVersion(), { slug: 'test-page', status: 'published', date_updated: '2026-09-06T12:00:00.000Z' })).toBeNull();
  });
  it('formats home page as base/', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'home', status: 'published', date_updated: '2026-09-06T12:00:00.000Z' })).toBe('https://example.com/');
  });
  it('formats other slugs as base/slug', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'about', status: 'published', date_updated: '2026-09-06T12:00:00.000Z' })).toBe('https://example.com/about');
  });
});

describe('pagePreviewUrl', () => {
  it('produces a portal-relative path', () => {
    expect(pagePreviewUrl('my-site', { slug: 'about' })).toBe('/api/sites/my-site/preview/browse/about');
  });
  it('treats home as the root', () => {
    expect(pagePreviewUrl('my-site', { slug: 'home' })).toBe('/api/sites/my-site/preview/browse/');
  });
});
