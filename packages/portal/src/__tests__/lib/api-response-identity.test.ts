// A site id is unique within an organization, not across them. Two sessions
// independently reached the wrong `moveria-se` in one day — one through a
// v1 key scoped to the other organization, one from a stored site_id — and
// both were caught by luck rather than by the response saying anything.
//
// These pin the response identifying what it actually reached.

import { describe, it, expect } from 'vitest';
import { apiResponse, withApiIdentity } from '../../lib/api-auth';

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

describe('withApiIdentity', () => {
  it('stamps a response built elsewhere without disturbing it', () => {
    const original = new Response('zip-bytes', {
      status: 200,
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="x.zip"' },
    });
    const stamped = withApiIdentity({ orgId: 'moveria-ab', siteId: 'moveria-se' }, original);
    expect(stamped.headers.get('Typeroll-Organization-Id')).toBe('moveria-ab');
    expect(stamped.headers.get('Content-Disposition')).toBe('attachment; filename="x.zip"');
    expect(stamped.status).toBe(200);
  });

  it('preserves an error status', () => {
    const stamped = withApiIdentity({ orgId: 'o', siteId: 's' }, new Response('{}', { status: 404 }));
    expect(stamped.status).toBe(404);
    expect(stamped.headers.get('Typeroll-Site-Id')).toBe('s');
  });
});

describe('every v1 site route identifies itself', () => {
  // The first version of this fix claimed apiResponse was a single seam for
  // all of them. It was the seam for 101 of 105, and the four exceptions —
  // both extension routes, owner-review and export — were exactly where an
  // extension integrator works. A structural check rather than four
  // hand-written cases, so the next route added through a different helper
  // fails here instead of shipping silent.
  it('returns through apiResponse, apiError with a context, or withApiIdentity', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, dirname, relative } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // Resolved from this file, not from cwd: the suite runs from the repo
    // root and from the workspace directory, and a relative literal is only
    // correct in one of them.
    const portal = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const root = join(portal, 'src/pages/api/v1/sites');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });

    const offenders = walk(root).filter((file) => {
      const source = readFileSync(file, 'utf8');
      // Only routes that actually resolve a site context can identify one.
      if (!/requireApiKey\b/.test(source)) return false;
      return !/apiResponse\(|withApiIdentity\(/.test(source);
    });
    expect(offenders.map((file) => relative(portal, file))).toEqual([]);
  });
});
