import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'testorg';
const SITE = 'mysite';
const OTHER_SITE = 'othersite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.site(ORG, OTHER_SITE), {
    name: 'Other',
    created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com',
  });
  return { token };
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('requireApiKey', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('accepts a valid bearer token and returns the site context', async () => {
    const { token } = await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.orgId).toBe(ORG);
      expect(r.value.siteId).toBe(SITE);
      expect(r.value.versionId).toBe(MAIN_VERSION_ID);
      expect(r.value.site.name).toBe('My Site');
    }
  });

  it('401 when Authorization header is missing', async () => {
    await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages`);
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('401 when token is malformed', async () => {
    await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('401 when the token is valid but the URL site doesn\'t match', async () => {
    const { token } = await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${OTHER_SITE}/pages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, OTHER_SITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('400 when siteId is missing from the URL', async () => {
    const { token } = await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest('https://api.example/v1/sites/-/pages', {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('401 after the key is revoked', async () => {
    const { token } = await setup();
    const { revokeApiKey, parseKey } = await import('../../lib/api-keys');
    const { requireApiKey } = await import('../../lib/api-auth');
    await revokeApiKey(ORG, SITE, parseKey(token)!.prefix);
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('opts into a feature branch via ?version=<id> when the branch exists', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, 'feature'), {
      name: 'Feature', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(), robots_blocked: false,
    } satisfies Partial<SiteVersion>);

    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages?version=feature`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.versionId).toBe('feature');
  });

  it('falls back to main for an unknown branch id', async () => {
    const { token } = await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages?version=nope`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.versionId).toBe(MAIN_VERSION_ID);
  });

  it('rejects malformed branch ids without hitting the store', async () => {
    const { token } = await setup();
    const { requireApiKey } = await import('../../lib/api-auth');
    // path traversal-style input — should be ignored, not 5xx.
    const req = makeRequest(`https://api.example/v1/sites/${SITE}/pages?version=../etc/passwd`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await requireApiKey(req, SITE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.versionId).toBe(MAIN_VERSION_ID);
  });
});
