// Organization AI settings routes and gating.
//   Portal: /api/orgs/ai, /api/orgs/ai/key, /api/orgs/ai/site-access
//   API:    /api/v1/organization/ai, .../key, .../site-access
//   Chat:   /api/sites/{siteId}/chat answers 403 ai_not_enabled without access
// MCP and the public API never depend on the setting.
//
// The cookie-less dev session is `dev-user` in organization `default`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

vi.mock('../../lib/anthropic', async (original) => ({
  ...(await original<typeof import('../../lib/anthropic')>()),
  runChatTurn: vi.fn(async () => ({ reply: 'synthetic reply', actions: [], tool_calls: [], iterations: 1 })),
}));

const ORG = 'default';
const OWNER_ORG = 'owner-org';
const SITE = 'mysite';
const OTHER_SITE = 'second';
const SHARED_SITE = 'shared-in';
const FAKE_KEY = 'sk-ant-api03-FAKE-route-test-key-0000LAST';
const origin = 'https://portal.test';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;

async function store() { return (await import('../../lib/datastore')).getStore(); }

function anthropic(status = 200) {
  const mock = vi.fn(async () => new Response('{}', { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function call(route: APIRoute, method: string, path: string, init: { body?: unknown; token?: string; headers?: Record<string, string>; params?: Record<string, string> } = {}) {
  const request = new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await route({ request, cookies, params: init.params ?? {}, locals: {} } as never) as Response;
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : {}) as any, headers: response.headers };
}

async function setRole(role: string, enforced = false) {
  const s = await store();
  await s.setDoc(paths.org(ORG), { name: 'Default', roles_enforced: enforced });
  await s.setDoc(`${paths.members(ORG)}/dev-user`, { role });
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', origin);
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  const s = await store();
  for (const [org, site] of [[ORG, SITE], [ORG, OTHER_SITE], [OWNER_ORG, SHARED_SITE]]) {
    await s.setDoc(paths.site(org, site), { name: site, created_at: '2026-01-01' });
    await s.setDoc(paths.version(org, site, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '2026-01-01' });
  }
  await setRole('owner');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function portalRoutes() {
  return {
    index: await import('../../pages/api/orgs/ai/index'),
    key: await import('../../pages/api/orgs/ai/key'),
    access: await import('../../pages/api/orgs/ai/site-access'),
  };
}

describe('portal organization AI routes', () => {
  it('lets an owner add, scope and remove the key without ever returning it', async () => {
    const { index, key, access } = await portalRoutes();
    const verify = anthropic(200);
    const put = await call(key.PUT, 'PUT', '/api/orgs/ai/key', { body: { api_key: FAKE_KEY } });
    expect(put.status).toBe(200);
    expect(put.headers.get('cache-control')).toBe('no-store');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(put.json).toMatchObject({ configured: true, key: { last4: 'LAST', set_by: 'dev-user' }, site_access: { mode: 'selected', site_ids: [] } });
    expect(put.text).not.toContain(FAKE_KEY);

    const scoped = await call(access.PUT, 'PUT', '/api/orgs/ai/site-access', { body: { mode: 'selected', site_ids: [SITE] } });
    expect(scoped.status).toBe(200);
    expect(scoped.json.sites).toEqual(expect.arrayContaining([
      { id: SITE, name: SITE, ai_enabled: true }, { id: OTHER_SITE, name: OTHER_SITE, ai_enabled: false },
    ]));
    // Only the organization's own Sites, never a shared-in one.
    expect(scoped.json.sites.map((site: { id: string }) => site.id)).not.toContain(SHARED_SITE);

    const read = await call(index.GET, 'GET', '/api/orgs/ai');
    expect(read.status).toBe(200);
    expect(read.text).not.toContain(FAKE_KEY);
    expect(read.text).not.toContain('v1.');

    const removed = await call(key.DELETE, 'DELETE', '/api/orgs/ai/key');
    expect(removed.json).toMatchObject({ configured: false, key: null });
  });

  it('reports a rejected key without echoing it', async () => {
    const { key } = await portalRoutes();
    anthropic(401);
    const put = await call(key.PUT, 'PUT', '/api/orgs/ai/key', { body: { api_key: FAKE_KEY } });
    expect(put.status).toBe(422);
    expect(put.json.code).toBe('ai_key_rejected');
    expect(put.text).not.toContain(FAKE_KEY);
  });

  it('lets an admin manage the key', async () => {
    await setRole('admin', true);
    const { index } = await portalRoutes();
    expect((await call(index.GET, 'GET', '/api/orgs/ai')).status).toBe(200);
  });

  it.each([['editor', false], ['editor', true], ['missing', false]])('refuses %s (roles enforced: %s)', async (role, enforced) => {
    if (role === 'missing') {
      await (await store()).deleteDoc(`${paths.members(ORG)}/dev-user`);
    } else await setRole(role, enforced);
    const verify = anthropic(200);
    const { index, key, access } = await portalRoutes();
    expect((await call(index.GET, 'GET', '/api/orgs/ai')).status).toBe(403);
    expect((await call(key.PUT, 'PUT', '/api/orgs/ai/key', { body: { api_key: FAKE_KEY } })).status).toBe(403);
    expect((await call(key.DELETE, 'DELETE', '/api/orgs/ai/key')).status).toBe(403);
    expect((await call(access.PUT, 'PUT', '/api/orgs/ai/site-access', { body: { mode: 'all' } })).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('public API organization AI routes', () => {
  async function apiRoutes() {
    return {
      index: await import('../../pages/api/v1/organization/ai/index'),
      key: await import('../../pages/api/v1/organization/ai/key'),
      access: await import('../../pages/api/v1/organization/ai/site-access'),
    };
  }
  async function token(orgId: string, siteId: string | null) {
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId, siteId, name: 'seed', createdBy: 'seed@example.test' })).token;
  }

  it('lets an organization key read, set and scope the key, auditing without the key', async () => {
    const { index, key, access } = await apiRoutes();
    const orgKey = await token(ORG, null);
    anthropic(200);
    const put = await call(key.PUT, 'PUT', '/api/v1/organization/ai/key', { token: orgKey, body: { api_key: FAKE_KEY } });
    expect(put.status).toBe(200);
    expect(put.json.key.set_by).toMatch(/^api-key:[a-f0-9]{12}$/);
    expect(put.text).not.toContain(FAKE_KEY);
    const scoped = await call(access.PUT, 'PUT', '/api/v1/organization/ai/site-access', { token: orgKey, body: { mode: 'all' } });
    expect(scoped.json.site_access).toEqual({ mode: 'all', site_ids: [] });
    const read = await call(index.GET, 'GET', '/api/v1/organization/ai', { token: orgKey });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.json.sites.every((site: { ai_enabled: boolean }) => site.ai_enabled)).toBe(true);
    expect(read.text).not.toContain(FAKE_KEY);

    // Give the fire-and-forget audit writes a moment, then check them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const audit = JSON.stringify(await (await store()).listDocs(paths.apiAudit(ORG, '')).catch(() => []));
    expect(audit).not.toContain(FAKE_KEY);
    expect((await call(key.DELETE, 'DELETE', '/api/v1/organization/ai/key', { token: orgKey })).json.configured).toBe(false);
  });

  it('refuses site-scoped keys and keeps organizations apart', async () => {
    const { index, key } = await apiRoutes();
    anthropic(200);
    const siteKey = await token(ORG, SITE);
    expect((await call(index.GET, 'GET', '/api/v1/organization/ai', { token: siteKey })).status).toBe(403);
    expect((await call(key.PUT, 'PUT', '/api/v1/organization/ai/key', { token: siteKey, body: { api_key: FAKE_KEY } })).status).toBe(403);

    await call(key.PUT, 'PUT', '/api/v1/organization/ai/key', { token: await token(ORG, null), body: { api_key: FAKE_KEY } });
    const other = await call(index.GET, 'GET', '/api/v1/organization/ai', { token: await token(OWNER_ORG, null) });
    expect(other.json).toMatchObject({ configured: false, key: null });
    expect(other.json.sites.map((site: { id: string }) => site.id)).toEqual([SHARED_SITE]);
  });

  it('requires a personal connection to select an organization where the person is owner or admin', async () => {
    const { createPersonalConnection } = await import('../../lib/api-keys');
    const { index } = await apiRoutes();
    const s = await store();
    await s.setDoc(paths.org(ORG), { name: 'Default', roles_enforced: true });
    await s.setDoc(`${paths.members(ORG)}/person`, { role: 'editor' });
    const personal = (await createPersonalConnection('person', 'Connector')).token;
    const headers = { 'Typeroll-Organization': ORG };
    expect((await call(index.GET, 'GET', '/api/v1/organization/ai', { token: personal, headers })).status).toBe(403);
    await s.setDoc(`${paths.members(ORG)}/person`, { role: 'owner' });
    expect((await call(index.GET, 'GET', '/api/v1/organization/ai', { token: personal, headers })).status).toBe(200);
  });
});

describe('AI chat gating', () => {
  async function chat(siteId: string) {
    const route = await import('../../pages/api/sites/[siteId]/chat');
    return call(route.POST, 'POST', `/api/sites/${siteId}/chat`, { body: { message: 'Hello' }, params: { siteId } });
  }
  async function enable(orgId: string, access: { mode: string; site_ids?: string[] }) {
    const { setAiKey, setAiSiteAccess } = await import('../../lib/ai/organization-ai');
    await setAiKey(orgId, { userId: 'owner' }, FAKE_KEY, (async () => new Response('{}', { status: 200 })) as never);
    await setAiSiteAccess(orgId, { userId: 'owner' }, access);
  }

  it('answers 403 ai_not_enabled and stores nothing without access', async () => {
    const res = await chat(SITE);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('ai_not_enabled');
    expect(res.json.error).toContain('Organization settings → AI assistant');
    expect(await (await store()).listDocs(paths.chat(ORG, SITE))).toEqual([]);
  });

  it('allows only the selected Site, and an editor there', async () => {
    await enable(ORG, { mode: 'selected', site_ids: [SITE] });
    await setRole('editor', true);
    expect((await chat(SITE)).status).toBe(200);
    expect((await chat(OTHER_SITE)).json.code).toBe('ai_not_enabled');
  });

  it('never gives read-only viewers the chat', async () => {
    await enable(ORG, { mode: 'all' });
    await (await store()).setDoc(paths.org(ORG), { name: 'Default', roles_enforced: true });
    await (await store()).deleteDoc(`${paths.members(ORG)}/dev-user`);
    expect((await chat(SITE)).status).toBe(403);
    const { canUseAiChat } = await import('../../lib/ai/organization-ai');
    expect(await canUseAiChat({ orgId: ORG, siteId: SITE }, 'read')).toBe(false);
    expect(await canUseAiChat({ orgId: ORG, siteId: SITE }, 'write')).toBe(true);
  });

  it('uses the OWNER organization’s key and allowlist on a shared-in Site', async () => {
    const s = await store();
    const share = { site_id: SHARED_SITE, owner_org_id: OWNER_ORG, shared_with_org_id: ORG, permission: 'write', created_at: Date.now(), created_by: 'seed' };
    await s.setDoc(paths.share(OWNER_ORG, SHARED_SITE, 'share-1'), share);
    await s.setDoc(paths.sharesWithOrgEntry(ORG, 'share-1'), share);
    // The recipient's own key, even for all of its Sites, does not apply.
    await enable(ORG, { mode: 'all' });
    expect((await chat(SHARED_SITE)).json.code).toBe('ai_not_enabled');
    await enable(OWNER_ORG, { mode: 'selected', site_ids: [SHARED_SITE] });
    expect((await chat(SHARED_SITE)).status).toBe(200);
  });
});

describe('MCP and the API without AI access', () => {
  it('an editor’s personal connection still writes through the API', async () => {
    const { createPersonalConnection } = await import('../../lib/api-keys');
    const { isAiEnabledForSite } = await import('../../lib/ai/organization-ai');
    const s = await store();
    await s.setDoc(paths.org(ORG), { name: 'Default', roles_enforced: true });
    await s.setDoc(`${paths.members(ORG)}/person`, { role: 'editor' });
    const personal = (await createPersonalConnection('person', 'Connector')).token;
    expect(await isAiEnabledForSite({ orgId: ORG, siteId: SITE })).toBe(false);
    const pages = await import('../../pages/api/v1/sites/[siteId]/pages/index');
    const created = await call(pages.POST, 'POST', `/api/v1/sites/${SITE}/pages`, {
      token: personal, headers: { 'Typeroll-Organization': ORG }, params: { siteId: SITE },
      body: { title: 'Written by my own agent', html_content: '<p>Hello</p>' },
    });
    expect(created.status).toBe(201);
    expect(created.json.page.title).toBe('Written by my own agent');
  });

  it('an organization key writes through the hosted MCP endpoint', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const token = (await createApiKey({ orgId: ORG, siteId: null, name: 'agent', createdBy: 'seed' })).token;
    const pages = await import('../../pages/api/v1/sites/[siteId]/pages/index');
    // The hosted MCP server calls the public API over HTTP; serve it in-process.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as string, init);
      const match = new URL(request.url).pathname.match(/^\/api\/v1\/sites\/([^/]+)\/pages$/);
      if (!match || request.method !== 'POST') return new Response('{"error":"unexpected"}', { status: 404 });
      return pages.POST({ request, params: { siteId: match[1] }, cookies, locals: {} } as never) as Promise<Response>;
    }));
    const { POST: hosted } = await import('../../pages/api/mcp/index');
    const response = await hosted({ request: new Request(`${origin}/api/mcp?tools=full`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_page', arguments: { site_id: SITE, title: 'MCP page', html_content: '<p>Hi</p>' } } }),
    }) } as never) as Response;
    const body = await response.json();
    expect(body.result.isError).toBeFalsy();
    const { vstore } = await import('../../lib/version-store');
    expect((await vstore.pages(ORG, SITE, MAIN_VERSION_ID)).map((page) => page.title)).toContain('MCP page');
  });
});
