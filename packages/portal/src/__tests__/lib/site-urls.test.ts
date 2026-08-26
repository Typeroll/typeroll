import { describe, it, expect } from 'vitest';
import { liveBaseFor, pageLiveUrl, pagePreviewUrl, siteDisplayHost } from '../../lib/site-urls';
import { MAIN_VERSION_ID } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const mainVersion: SiteVersion = {
  id: MAIN_VERSION_ID,
  name: 'Main',
  kind: 'main',
  created_at: '',
};
const branchVersion = (deploy_url?: string): SiteVersion => ({
  id: 'feat',
  name: 'feat',
  kind: 'branch',
  base_version_id: MAIN_VERSION_ID,
  created_at: '',
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
  it('formats home page as base/', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'home', status: 'published' })).toBe('https://example.com/');
  });
  it('formats other slugs as base/slug', () => {
    expect(pageLiveUrl(site, mainVersion, { slug: 'about', status: 'published' })).toBe('https://example.com/about');
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
