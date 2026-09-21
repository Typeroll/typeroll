// A site id is unique within an organization, not across them. Two sessions
// independently reached the wrong `moveria-se` in one day — one through a
// v1 key scoped to the other organization, one from a stored site_id — and
// both were caught by luck rather than by the response saying anything.
//
// These pin the response identifying what it actually reached.

import { describe, it, expect } from 'vitest';
import { apiResponse } from '../../lib/api-auth';

function ctx(over: Record<string, unknown> = {}) {
  return {
    orgId: 'moveria-ab',
    siteId: 'moveria-se',
    keyPrefix: 'typeroll_live_abc',
    path: '/api/v1/sites/moveria-se/pages/home',
    request: new Request('https://app.typeroll.com/api/v1/sites/moveria-se/pages/home', { method: 'GET' }),
    ...over,
  } as never;
}

describe('apiResponse identity headers', () => {
  it('names the organization it resolved, not the one the caller assumed', () => {
    const response = apiResponse(ctx({ orgId: 'autopilot-sverige-ab-4' }), { ok: true });
    expect(response.headers.get('Typeroll-Organization-Id')).toBe('autopilot-sverige-ab-4');
    expect(response.headers.get('Typeroll-Site-Id')).toBe('moveria-se');
  });

  it('identifies writes too, which is where a silent wrong-site edit lands', () => {
    const request = new Request('https://app.typeroll.com/api/v1/sites/moveria-se/pages/home', { method: 'PUT' });
    const response = apiResponse(ctx({ request, orgId: 'autopilot-sverige-ab-4' }), { ok: true });
    expect(response.headers.get('Typeroll-Organization-Id')).toBe('autopilot-sverige-ab-4');
  });

  it('omits the site header for an org-scoped context rather than sending an empty one', () => {
    const response = apiResponse(ctx({ siteId: '' }), { sites: [] });
    expect(response.headers.get('Typeroll-Organization-Id')).toBe('moveria-ab');
    expect(response.headers.has('Typeroll-Site-Id')).toBe(false);
  });

  it('leaves the body untouched — the contract is unchanged', async () => {
    const response = apiResponse(ctx(), { pages: [{ id: 'home' }] });
    expect(await response.json()).toEqual({ pages: [{ id: 'home' }] });
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });
});
