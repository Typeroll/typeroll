// Which audiences an internal route accepts.
//
// A Google OIDC token's `aud` is whatever the caller was configured with, and
// two different callers hit two different paths: Cloud Tasks posts
// /api/internal/deploy-worker, Cloud Scheduler posts /api/internal/publish-sweep.
// Keying only on DEPLOY_WORKER_URL accepted the deploy worker's URL and nothing
// else, so a correctly configured scheduler job would fail verification and the
// sweep would silently never run — and splitting the worker onto its own
// service would break the sweep on the portal for the same reason.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expectedAudiences } from '../../lib/internal-auth';

const req = (url: string) => new Request(url, { method: 'POST' });

describe('expectedAudiences', () => {
  const original = process.env.DEPLOY_WORKER_URL;
  beforeEach(() => { delete process.env.DEPLOY_WORKER_URL; });
  afterEach(() => {
    if (original === undefined) delete process.env.DEPLOY_WORKER_URL;
    else process.env.DEPLOY_WORKER_URL = original;
  });

  it('always accepts the route the caller actually posted to', () => {
    const url = 'https://portal.example.com/api/internal/publish-sweep';
    expect(expectedAudiences(req(url))).toContain(url);
  });

  it('accepts the sweep path even when DEPLOY_WORKER_URL names the worker path', () => {
    // The live shape: one service, two internal routes, one env var that only
    // ever named one of them.
    process.env.DEPLOY_WORKER_URL = 'https://portal.example.com/api/internal/deploy-worker';
    const sweep = 'https://portal.example.com/api/internal/publish-sweep';
    expect(expectedAudiences(req(sweep))).toContain(sweep);
  });

  it('still accepts DEPLOY_WORKER_URL, so a split-out worker keeps verifying', () => {
    // Cloud Tasks mints `aud` from the portal's DEPLOY_WORKER_URL. If the
    // worker moves to its own service and its request URL differs (custom
    // domain, run.app hostname), the configured value has to stay valid.
    process.env.DEPLOY_WORKER_URL = 'https://deploy-worker.example.com/api/internal/deploy-worker';
    const audiences = expectedAudiences(req('https://worker-xyz.run.app/api/internal/deploy-worker'));
    expect(audiences).toContain('https://deploy-worker.example.com/api/internal/deploy-worker');
    expect(audiences).toContain('https://worker-xyz.run.app/api/internal/deploy-worker');
  });

  it('does not duplicate when the configured URL is the request URL', () => {
    const url = 'https://portal.example.com/api/internal/deploy-worker';
    process.env.DEPLOY_WORKER_URL = url;
    expect(expectedAudiences(req(url))).toEqual([url]);
  });

  it('never returns an empty list, which would accept any audience', () => {
    // google-auth-library treats an empty/absent audience as "don't check",
    // so an empty result would silently disable the binding entirely.
    expect(expectedAudiences(req('https://portal.example.com/api/internal/publish-sweep')).length)
      .toBeGreaterThan(0);
  });
});
