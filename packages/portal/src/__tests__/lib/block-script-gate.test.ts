// Script policy across agent surfaces (decided 2026-06-11):
//  - Bearer API keys (v1 REST, and MCP which wraps it) write `script`
//    FREELY — same trust level as scripts_head, which the same token
//    already authorises. Mitigation is visibility: the response carries
//    SCRIPT_WRITE_NOTICE and the write is audit-logged. The old
//    ai_scripts_enabled flag has NO effect on bearer paths.
//  - The in-portal chat AI stays gated on Site.ai_scripts_enabled —
//    covered by gateBlockScript unit tests here and the chat-path tests
//    in anthropic-tools.test.ts (which assert script never persists).

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { BlockType, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(siteOver: Partial<Site> = {}): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(), ...siteOver,
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null ? JSON.stringify(init.body) : undefined;
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

const CREATE_BODY = {
  name: 'fancy_widget',
  label: 'Fancy widget',
  template: '<div data-block="fancy_widget">{{text}}</div>',
  schema: [{ name: 'text', type: 'text', label: 'Text' }],
  script: 'console.log("hi")',
};

describe('BlockType script via bearer key — accepted + noticed', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('POST persists script and carries the write notice (no site flag needed)', async () => {
    const { token } = await setup(); // ai_scripts_enabled NOT set
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/block-types/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/block-types`,
      { siteId: SITE },
      { headers: bearer(token), body: CREATE_BODY },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { script?: string; warnings?: string[] };
    expect(body.script).toBe('console.log("hi")');
    expect(body.warnings?.[0]).toContain('visitor-executed JavaScript');

    const { getStore } = await import('../../lib/datastore');
    const stored = await getStore().getDoc<BlockType>(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/fancy_widget`,
    );
    expect(stored?.script).toBe('console.log("hi")');
  });

  it('PATCH persists script with notice; ai_scripts_enabled=false has no effect', async () => {
    const { token } = await setup({ ai_scripts_enabled: false } as Partial<Site>);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/fancy_widget`, {
      name: 'fancy_widget', label: 'Old', schema: [], origin: 'ai', created_at: new Date().toISOString(),
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/block-types/[typeId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/block-types/fancy_widget`,
      { siteId: SITE, typeId: 'fancy_widget' },
      { headers: bearer(token), body: { label: 'New', script: 'console.log("upd")' } },
    );
    const body = await res.json() as { label: string; script?: string; warnings?: string[] };
    expect(body.label).toBe('New');
    expect(body.script).toBe('console.log("upd")');
    expect(body.warnings?.length).toBe(1);
  });

  it('script-free writes carry no notice', async () => {
    const { token } = await setup();
    const { script: _omit, ...noScript } = CREATE_BODY;
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/block-types/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/block-types`,
      { siteId: SITE },
      { headers: bearer(token), body: noScript },
    );
    const body = await res.json() as { warnings?: string[] };
    expect(body.warnings).toBeUndefined();
  });
});

describe('gateBlockScript unit (chat-only gate)', () => {
  it('no script in payload → no warnings, payload untouched', async () => {
    const { gateBlockScript } = await import('../../lib/block-script-gate');
    const payload: { script?: string; template?: string } = { template: '<div/>' };
    expect(gateBlockScript(payload, {})).toEqual([]);
    expect(payload.template).toBe('<div/>');
  });

  it('strips script when the site has not opted in', async () => {
    const { gateBlockScript } = await import('../../lib/block-script-gate');
    const payload = { script: 'x' };
    const warnings = gateBlockScript(payload, {});
    expect(warnings.length).toBe(1);
    expect(payload.script).toBeUndefined();
  });

  it('truthy-but-not-true flag values do NOT enable', async () => {
    const { gateBlockScript } = await import('../../lib/block-script-gate');
    const payload = { script: 'x' };
    const warnings = gateBlockScript(payload, { ai_scripts_enabled: 'yes' } as any);
    expect(warnings.length).toBe(1);
    expect(payload.script).toBeUndefined();
  });
});
