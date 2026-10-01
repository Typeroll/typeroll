// Site email settings over the v1 API (and so MCP): the outgoing connector,
// its test send and incoming forwarding use the portal's validation and
// masking, with the same admin permission as Settings → Email & notifications.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { Site, SiteIntegrations } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const SITE = 'mysite';

const auth = vi.hoisted(() => ({ permission: 'admin' as string, extension: false }));
const send = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-auth')>();
  return {
    ...actual,
    requireApiKey: async (request: Request, siteId: string) => ({
      ok: true,
      value: {
        orgId: ORG, tokenOrgId: ORG, tokenSiteId: siteId, siteId, versionId: 'main',
        site: { id: siteId, name: 'My <Site>' }, keyPrefix: 'test', permission: auth.permission,
        request, path: new URL(request.url).pathname,
        ...(auth.extension ? { extensionIdentity: { installationId: 'app-one', scopes: ['forms:read', 'forms:write'] } } : {}),
      },
    }),
  };
});
vi.mock('../../lib/email/index', async (importOriginal) => ({
  ...await importOriginal<object>(),
  sendViaConnector: send,
}));

const cookies = { get: () => undefined } as never;
const locals = {} as never;

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  auth.permission = 'admin';
  auth.extension = false;
  send.mockReset();
  process.env.INTEGRATIONS_SECRET_KEY = 'unit-test-integrations-key-please-change-32+chars';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My <Site>', created_at: new Date().toISOString() } satisfies Partial<Site>);
});
afterEach(() => { delete process.env.EMAIL_SES_INBOUND_ROUTES; });

async function v1Email(method: 'GET' | 'PUT' | 'DELETE', body?: unknown): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/integrations/email');
  const request = new Request(`http://localhost/api/v1/sites/${SITE}/integrations/email`, {
    method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return (mod as Record<string, (ctx: unknown) => Promise<Response>>)[method]!({ request, params: { siteId: SITE } });
}

async function v1Test(body: unknown): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/integrations/email/test');
  const request = new Request(`http://localhost/api/v1/sites/${SITE}/integrations/email/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return mod.POST({ request, params: { siteId: SITE } } as never);
}

const smtp = { type: 'smtp', from: 'Site <a@b.com>', config: { host: 'smtp.x.com', port: 587, secure: false, user: 'u', password: 'super-secret' } };

describe('v1 email connector', () => {
  it('stores the connector encrypted and returns it masked, like the portal', async () => {
    const put = await v1Email('PUT', smtp);
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain('super-secret');

    const { getStore } = await import('../../lib/datastore');
    const { decryptSecret } = await import('../../lib/secret-crypto');
    const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(ORG, SITE));
    expect(decryptSecret(doc!.email!.config.password_enc as string)).toBe('super-secret');

    const got = await (await v1Email('GET')).json();
    expect(got.email).toMatchObject({ type: 'smtp', from: 'Site <a@b.com>', config: { host: 'smtp.x.com', password: { set: true } } });
    expect(got.providers.map((p: { type: string }) => p.type)).toEqual(expect.arrayContaining(['postmark', 'smtp']));
    expect(got.crypto_configured).toBe(true);
    expect(JSON.stringify(got)).not.toMatch(/super-secret|password_enc|v1\./);
  });

  it('keeps a stored secret when it is omitted or masked', async () => {
    await v1Email('PUT', smtp);
    await v1Email('PUT', { ...smtp, from: 'Changed <a@b.com>', config: { host: 'smtp.x.com', user: 'u' } });
    await v1Email('PUT', { ...smtp, config: { ...smtp.config, password: '••••••••' } });
    const { getStore } = await import('../../lib/datastore');
    const { decryptSecret } = await import('../../lib/secret-crypto');
    const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(ORG, SITE));
    expect(decryptSecret(doc!.email!.config.password_enc as string)).toBe('super-secret');
  });

  it('validates like the portal', async () => {
    expect((await v1Email('PUT', { type: 'mailgun', from: 'a@b.com', config: {} })).status).toBe(400);
    expect((await v1Email('PUT', { type: 'postmark', from: 'a@b.com', config: {} })).status).toBe(400);
    expect((await v1Email('PUT', { type: 'smtp', from: '', config: smtp.config })).status).toBe(400);
    expect((await v1Email('PUT', { ...smtp, config: 'nope' })).status).toBe(400);
    delete process.env.INTEGRATIONS_SECRET_KEY;
    expect((await v1Email('PUT', smtp)).status).toBe(503);
  });

  it('disconnects the connector', async () => {
    await v1Email('PUT', smtp);
    const res = await v1Email('DELETE');
    expect(await res.json()).toEqual({ removed: true, email: null });
    expect((await (await v1Email('GET')).json()).email).toBeNull();
    expect((await (await v1Email('DELETE')).json()).removed).toBe(false);
  });

  it('sends a test email through the stored connector', async () => {
    expect((await v1Test({ to: 'me@example.com' })).status).toBe(400); // nothing connected yet
    await v1Email('PUT', smtp);
    expect((await v1Test({})).status).toBe(400);
    send.mockResolvedValueOnce({ ok: true, id: 'msg-1' });
    const res = await v1Test({ to: 'me@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'msg-1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'smtp' }), expect.objectContaining({
      to: 'me@example.com', html: expect.stringContaining('My &lt;Site&gt;'),
    }));
    send.mockResolvedValueOnce({ ok: false, error: 'Rejected sender' });
    const failed = await v1Test({ to: 'me@example.com' });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe('Rejected sender');
  });

  it.each(['write', 'read'])('refuses %s permission on every operation', async (permission) => {
    auth.permission = permission;
    expect((await v1Email('GET')).status).toBe(403);
    expect((await v1Email('PUT', smtp)).status).toBe(403);
    expect((await v1Email('DELETE')).status).toBe(403);
    expect((await v1Test({ to: 'me@example.com' })).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('is never in an installation credential scope', async () => {
    const { extensionScopeForApiRequest } = await import('../../lib/api-auth');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect(extensionScopeForApiRequest(`/api/v1/sites/${SITE}/integrations/email`, method)).toBeNull();
    }
    expect(extensionScopeForApiRequest(`/api/v1/sites/${SITE}/integrations/email/test`, 'POST')).toBeNull();
    expect(extensionScopeForApiRequest(`/api/v1/sites/${SITE}/form-capabilities`, 'GET')).toBeNull();
  });
});

describe('portal email connector route', () => {
  it('disconnects through the shared logic', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/integrations/email');
    const put = new Request(`http://localhost/api/sites/${SITE}/integrations/email`, { method: 'PUT', body: JSON.stringify(smtp) });
    expect((await mod.PUT({ request: put, cookies, params: { siteId: SITE }, locals } as never)).status).toBe(200);
    const del = new Request(`http://localhost/api/sites/${SITE}/integrations/email`, { method: 'DELETE' });
    expect(await (await mod.DELETE({ request: del, cookies, params: { siteId: SITE }, locals } as never)).json()).toMatchObject({ removed: true });
  });
});

describe('incoming email forwarding settings', () => {
  const route = { id: 'replies', orgId: ORG, siteId: SITE, installationId: 'core-forwarding',
    alias: 'replies@mail.example.com', target: 'owner@example.net', from: 'notifications@mail.example.com',
    bucket: 'private-inbound', prefix: 'site-replies/', region: 'eu-central-1',
    topic: 'arn:aws:sns:eu-central-1:123456789012:inbound' };

  async function v1Inbound(method: 'GET' | 'PUT', body?: string): Promise<Response> {
    const mod = await import('../../pages/api/v1/sites/[siteId]/delivery/inbound');
    const request = new Request(`http://localhost/api/v1/sites/${SITE}/delivery/inbound`, { method, body });
    return (mod as Record<string, (ctx: unknown) => Promise<Response>>)[method]!({ request, params: { siteId: SITE } });
  }
  async function portalInbound(method: 'GET' | 'PUT', body?: string): Promise<Response> {
    const mod = await import('../../pages/api/sites/[siteId]/integrations/inbound-email');
    const request = new Request(`http://localhost/api/sites/${SITE}/integrations/inbound-email`, { method, body });
    return (mod as Record<string, (ctx: unknown) => Promise<Response>>)[method]!({ request, cookies, params: { siteId: SITE }, locals });
  }

  it('enables a route through the API and reports the same state as the portal', async () => {
    process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([route]);
    const { routes } = await (await v1Inbound('GET')).json();
    expect(routes[0]).toMatchObject({ route_id: 'replies', target: route.target, enabled: false });
    const res = await v1Inbound('PUT', JSON.stringify({ route_id: 'replies', revision: routes[0].revision, enabled: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).routes[0].enabled).toBe(true);
    expect((await (await portalInbound('GET')).json()).routes[0].enabled).toBe(true);
    const stale = await v1Inbound('PUT', JSON.stringify({ route_id: 'replies', revision: 'old', enabled: false }));
    expect(stale.status).toBe(409);
  });

  it('answers malformed input with 400 on both surfaces', async () => {
    process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([route]);
    expect((await v1Inbound('PUT', 'not json')).status).toBe(400);
    expect((await portalInbound('PUT', 'not json')).status).toBe(400);
    expect((await v1Inbound('PUT', '[]')).status).toBe(400);
    expect((await portalInbound('PUT', '[]')).status).toBe(400);
  });

  it('reports a broken host configuration with the same status on both surfaces', async () => {
    process.env.EMAIL_SES_INBOUND_ROUTES = 'not json';
    expect((await v1Inbound('GET')).status).toBe(503);
    expect((await portalInbound('GET')).status).toBe(503);
  });

  it('requires admin permission for API keys', async () => {
    process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([route]);
    auth.permission = 'write';
    expect((await v1Inbound('GET')).status).toBe(403);
    expect((await v1Inbound('PUT', JSON.stringify({ route_id: 'replies', revision: 'x', enabled: true }))).status).toBe(403);
  });
});
