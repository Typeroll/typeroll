import { describe, it, expect } from 'vitest';
import {
  DOMAIN_STATE_LABEL,
  domainState,
  isCanonicalReady,
  isServingOnOwnDomain,
  publicUrlsFor,
} from '../../lib/site-public-urls';
import type { Site } from '@typeroll/shared';

function site(over: Partial<Site>): Site & { id: string } {
  return {
    id: 'autopilot',
    name: 'Autopilot',
    hosting_adapter: 'cloudflare',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Site & { id: string };
}

// Domain-first model: a declared domain IS the canonical/production host
// immediately, regardless of DNS-verification status. domain_status is a
// DNS-health diagnostic only — it never gates the canonical. This is what
// prevents the internal *.sites fallback from leaking into a public sitemap.

describe('isCanonicalReady — declared domain is canonical', () => {
  it('is false when no domain is declared (develop-on-the-subdomain phase)', () => {
    expect(isCanonicalReady(site({}))).toBe(false);
  });

  it('is true the moment a domain is declared, even before DNS is pointed (pending)', () => {
    expect(isCanonicalReady(site({ domain: 'autopilot.se', domain_status: 'pending' }))).toBe(true);
  });

  it('is true when verified', () => {
    expect(isCanonicalReady(site({ domain: 'autopilot.se', domain_status: 'verified' }))).toBe(true);
  });

  it('is true when live, and for legacy sites with a domain but no status', () => {
    expect(isCanonicalReady(site({ domain: 'autopilot.se', domain_status: 'live' }))).toBe(true);
    expect(isCanonicalReady(site({ domain: 'autopilot.se' }))).toBe(true);
  });

  it('is true even when CF verification failed — the declared domain is still the canonical the customer chose', () => {
    expect(isCanonicalReady(site({ domain: 'autopilot.se', domain_status: 'failed' }))).toBe(true);
  });
});

describe('publicUrlsFor — production (visit-this URL) gates on DNS; canonical does not', () => {
  it('production stays null while DNS is pending (agents fall back), but canonical is already the domain', () => {
    const s = site({ domain: 'autopilot.se', domain_status: 'pending' });
    // Canonical baked into the build = the domain (no subdomain leak)…
    expect(isCanonicalReady(s)).toBe(true);
    // …but the agent-facing live URL waits for DNS so it never points the
    // customer at a domain that doesn't resolve yet (original autopilot bug).
    const urls = publicUrlsFor(s);
    expect(urls.production).toBeNull();
    expect(urls.pending_domain).toBe('autopilot.se');
    expect(urls.domain_status).toBe('pending');
  });

  it('production becomes the domain once DNS is verified (no separate activation), pending_domain clears', () => {
    const urls = publicUrlsFor(site({ domain: 'autopilot.se', domain_status: 'verified' }));
    expect(urls.production).toBe('https://autopilot.se');
    expect(urls.pending_domain).toBeNull();
  });

  it('production stays null when DNS failed; canonical is still the declared domain', () => {
    const s = site({ domain: 'autopilot.se', domain_status: 'failed' });
    expect(isCanonicalReady(s)).toBe(true);
    expect(publicUrlsFor(s).production).toBeNull();
  });

  it('no domain → no production URL (still developing on the fallback)', () => {
    const urls = publicUrlsFor(site({}));
    expect(urls.production).toBeNull();
    expect(urls.domain_status).toBeNull();
  });
});

// domainState replaced Site.status across the dashboards, the site switcher
// and the operator console in 0.30.0. Site.status was a lifecycle label
// written once at creation and never advanced, so it reported sites serving
// production traffic as 'planning'. These pin the substitute.
describe('domainState', () => {
  it('is live only when DNS is confirmed', () => {
    expect(domainState({ domain: 'a.se', domain_status: 'verified' })).toBe('live');
    expect(domainState({ domain: 'a.se', domain_status: 'live' })).toBe('live');
  });

  it('is pending while a domain is declared but unconfirmed', () => {
    expect(domainState({ domain: 'a.se', domain_status: 'pending' })).toBe('pending');
    // Legacy docs predate domain_status entirely — declared but unproven, so
    // pending is the honest answer, not live.
    expect(domainState({ domain: 'a.se' })).toBe('pending');
  });

  it('surfaces a failed DNS check rather than hiding it as pending', () => {
    expect(domainState({ domain: 'a.se', domain_status: 'failed' })).toBe('failed');
  });

  it('is none when no domain has been declared', () => {
    expect(domainState({})).toBe('none');
    // A domain_status without a domain can't mean the site is serving.
    expect(domainState({ domain_status: 'verified' })).toBe('none');
  });

  it('ignores a legacy Site.status field entirely', () => {
    // The exact production shape that produced "0 live" on the console.
    const legacy = { domain: 'autopilot.se', domain_status: 'verified', status: 'planning' };
    expect(domainState(legacy)).toBe('live');
    expect(isServingOnOwnDomain(legacy)).toBe(true);
  });

  it('isServingOnOwnDomain is true only for the live state', () => {
    expect(isServingOnOwnDomain({ domain: 'a.se', domain_status: 'verified' })).toBe(true);
    for (const st of ['pending', 'failed', undefined]) {
      expect(isServingOnOwnDomain({ domain: 'a.se', domain_status: st })).toBe(false);
    }
    expect(isServingOnOwnDomain({})).toBe(false);
  });

  it('every state has a label', () => {
    for (const s of ['live', 'pending', 'failed', 'none'] as const) {
      expect(DOMAIN_STATE_LABEL[s]).toBeTruthy();
    }
  });
});
