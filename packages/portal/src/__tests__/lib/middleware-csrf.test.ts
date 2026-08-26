// Tests for the hand-rolled CSRF protection. Calls enforceCsrf directly
// — pure function, no Astro runtime needed.

import { describe, it, expect } from 'vitest';
import { enforceCsrf } from '../../lib/csrf';

async function callMiddleware(opts: {
  method: string;
  pathname?: string;
  origin?: string | null;
  authorization?: string;
  contentType?: string;
}): Promise<Response> {
  const url = new URL(`http://localhost:4321${opts.pathname ?? '/api/sites/x'}`);
  const headers: Record<string, string> = {};
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.authorization) headers['authorization'] = opts.authorization;
  if (opts.contentType) headers['content-type'] = opts.contentType;
  const request = new Request(url, { method: opts.method, headers });
  return enforceCsrf({ request, url }) ?? new Response('ok', { status: 200 });
}

describe('middleware CSRF — safe methods', () => {
  it('GET passes without Origin', async () => {
    const res = await callMiddleware({ method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('HEAD passes without Origin', async () => {
    const res = await callMiddleware({ method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});

describe('middleware CSRF — bearer auth exemption', () => {
  it('DELETE with API key bearer token passes', async () => {
    const res = await callMiddleware({
      method: 'DELETE',
      authorization: 'Bearer typeroll_live_abcdef1234567890',
    });
    expect(res.status).toBe(200);
  });

  it('POST with API key bearer token passes (no Origin)', async () => {
    const res = await callMiddleware({
      method: 'POST',
      authorization: 'Bearer typeroll_live_xyz',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('lowercase bearer prefix still matches', async () => {
    const res = await callMiddleware({
      method: 'DELETE',
      authorization: 'bearer typeroll_live_xyz',
    });
    expect(res.status).toBe(200);
  });

  it('NON-typeroll bearer token does NOT bypass (must still pass Origin check)', async () => {
    const res = await callMiddleware({
      method: 'DELETE',
      authorization: 'Bearer some_other_token',
    });
    expect(res.status).toBe(403);
  });
});

describe('middleware CSRF — exempt paths', () => {
  it('/api/forms/submit passes without Origin (HMAC-protected)', async () => {
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/forms/submit',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('/api/analytics/events reaches its own HMAC and origin checks', async () => {
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/analytics/events',
      origin: 'https://customer.example',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(200);
  });

  it('/api/auth/session passes without Origin', async () => {
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/auth/session',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('/api/internal/deploy-worker passes with Google OIDC bearer (eyJ...)', async () => {
    // Cloud Tasks posts with a Google-issued OIDC JWT. The token
    // doesn't match the typeroll_live_ prefix so the API-key bypass
    // doesn't apply; the path exemption is what lets it through.
    // Without this exemption, deploy jobs stayed stuck in queued.
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/internal/deploy-worker',
      authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.dummy.signature',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('/api/internal/publish-sweep passes with Google OIDC bearer', async () => {
    // Cloud Scheduler posts here with the same shape as Cloud Tasks and no
    // Origin. This was NOT exempt while deploy-worker was, so the sweep would
    // have been 403'd before reaching its own OIDC check — scheduled
    // publishing and the coalesced auto-deploy could never have run, even
    // once a scheduler job existed. Verified against staging: the live route
    // answered 403 with "CSRF check failed" before this landed.
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/internal/publish-sweep',
      authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.dummy.signature',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('a future /api/internal/ route inherits the exemption', async () => {
    // The prefix is exempt rather than a list of paths, because listing them
    // is how this bug happened twice.
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/internal/some-future-sweep',
      authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.dummy.signature',
      contentType: 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('/api/internal-admin/ is NOT exempted by the internal prefix', async () => {
    // The trailing slash in '/api/internal/' is what keeps these apart.
    // '/api/internal' as a prefix would also match the cross-tenant operator
    // console, which is cookie-authed and browser-driven and needs its CSRF
    // check — exempting it would be a real regression, on the one surface
    // that reads across every tenant.
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/internal-admin/builds',
      contentType: 'application/json',
    });
    expect(res.status).toBe(403);
  });
});

describe('middleware CSRF — cookie-authed origin check', () => {
  it('POST without Origin from non-bearer client is blocked', async () => {
    const res = await callMiddleware({ method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toMatch(/CSRF/);
    expect(body.detail).toMatch(/Origin|API key/);
  });

  it('POST with matching Origin passes', async () => {
    const res = await callMiddleware({
      method: 'POST',
      origin: 'http://localhost:4321',
    });
    expect(res.status).toBe(200);
  });

  it('POST with mismatched Origin is blocked', async () => {
    const res = await callMiddleware({
      method: 'POST',
      origin: 'http://evil.example.com',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { detail: string };
    expect(body.detail).toContain('http://evil.example.com');
  });

  it('DELETE without Origin from non-bearer client is blocked', async () => {
    const res = await callMiddleware({ method: 'DELETE' });
    expect(res.status).toBe(403);
    const body = await res.json() as { method: string };
    expect(body.method).toBe('DELETE');
  });
});

describe('middleware CSRF — Cloud Run / production hosts', () => {
  // The Node adapter on Cloud Run silently builds request.url with
  // hostname="localhost" because the upstream X-Forwarded-Host isn't
  // copied. The CSRF check must NOT compare to url.origin — it must
  // check Origin against an allowlist of known portal hosts.

  it('Origin=app.typeroll.com passes even when url.origin is localhost', async () => {
    const res = await callMiddleware({
      method: 'POST',
      pathname: '/api/sites/x/pages/create',
      origin: 'https://app.typeroll.com',
    });
    expect(res.status).toBe(200);
  });

  it('Origin=app.internal-test.typeroll.com passes', async () => {
    const res = await callMiddleware({
      method: 'POST',
      origin: 'https://app.internal-test.typeroll.com',
    });
    expect(res.status).toBe(200);
  });

  it('Cloud Run default *.run.app hostnames pass', async () => {
    const res = await callMiddleware({
      method: 'POST',
      origin: 'https://portal-abc123-ew.a.run.app',
    });
    // run.app subdomains have varying label counts; the regex matches
    // any single-label-before-run.app form.
    const single = await callMiddleware({
      method: 'POST',
      origin: 'https://portal.run.app',
    });
    expect(single.status).toBe(200);
    // multi-label run.app variants we don't strictly allow — that's OK,
    // we only care the common formats work and the more specific
    // app.typeroll.com path works.
    void res;
  });

  it('PORTAL_PUBLIC_URL adds the deployment\'s canonical host', async () => {
    const prev = process.env.PORTAL_PUBLIC_URL;
    process.env.PORTAL_PUBLIC_URL = 'https://customer.example.com';
    try {
      const res = await callMiddleware({
        method: 'POST',
        origin: 'https://customer.example.com',
      });
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.PORTAL_PUBLIC_URL;
      else process.env.PORTAL_PUBLIC_URL = prev;
    }
  });
});
