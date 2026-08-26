// End-to-end-ish test of the v1 blocks import + export routes. Hits the
// route handlers directly (no HTTP server) and walks an export → import
// round-trip via the public API surface.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { BlockType, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
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

async function seedBlock(id: string, overrides: Partial<BlockType> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const doc: BlockType = {
    id,
    name: id.replace(/[^a-z0-9]+/g, '_'),
    label: id,
    category: 'content',
    container: false,
    schema: [{ name: 'msg', type: 'text', label: 'Message' }],
    template: '<p data-block-type="user/sample">{{msg}}</p>',
    styles: '.sample{color:red}',
    script: 'console.log("user block")',
    origin: 'user',
    created_at: '2026-05-22T10:00:00Z',
    ...overrides,
  };
  await getStore().setDoc(
    `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/${id}`,
    doc,
  );
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST', APIRoute>>>,
  method: 'GET' | 'POST',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string'
    ? JSON.stringify(init.body)
    : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

describe('GET /v1/.../blocks/export', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('packs every user block into a base64 zip', async () => {
    const { token } = await setup();
    await seedBlock('first');
    await seedBlock('second');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      manifest: { name: string; version: string; blocks: string[] };
      zip_base64: string;
      block_count: number;
    };
    expect(body.block_count).toBe(2);
    expect(body.manifest.blocks).toContain('first');
    expect(body.manifest.blocks).toContain('second');
    expect(body.zip_base64.length).toBeGreaterThan(100);
  });

  it('honors ids filter', async () => {
    const { token } = await setup();
    await seedBlock('first');
    await seedBlock('second');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export?ids=first`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { block_count: number; manifest: { blocks: string[] } };
    expect(body.block_count).toBe(1);
    expect(body.manifest.blocks).toEqual(['first']);
  });

  it('returns 200 with empty payload when no user blocks exist', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      block_count: number;
      zip_base64: string | null;
      manifest: { blocks: string[] };
      note?: string;
    };
    expect(body.block_count).toBe(0);
    expect(body.zip_base64).toBeNull();
    expect(body.manifest.blocks).toEqual([]);
    expect(body.note).toMatch(/no user-created/i);
  });

  it('returns 200 with empty payload when ids filter matches nothing', async () => {
    const { token } = await setup();
    await seedBlock('present');
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export?ids=nonexistent,also-missing`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { block_count: number; note?: string };
    expect(body.block_count).toBe(0);
    expect(body.note).toMatch(/nonexistent/);
  });

  it('rejects unauthenticated calls', async () => {
    await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export`,
      { siteId: SITE },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/.../blocks/import', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('re-imports an exported zip — round-trip preserves template/styles/script', async () => {
    const { token } = await setup();
    await seedBlock('source-block');

    // 1. Export
    const exportRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export?name=trip&version=2`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(exportRes.status).toBe(200);
    const exported = await exportRes.json() as { zip_base64: string };

    // 2. Delete the original so import has to do work
    const { getStore } = await import('../../lib/datastore');
    await getStore().deleteDoc(`${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/source-block`);

    // 3. Import the same zip back
    const importRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/import'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/blocks/import`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: { zip_base64: exported.zip_base64 },
      },
    );
    expect(importRes.status).toBe(200);
    const imported = await importRes.json() as {
      created: number; updated: number; block_type_ids: string[];
    };
    expect(imported.created).toBe(1);
    expect(imported.updated).toBe(0);
    expect(imported.block_type_ids).toEqual(['source_block']);

    // 4. Verify the doc is written with the imported_from metadata
    const restored = await getStore().getDoc<BlockType>(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/source_block`,
    );
    expect(restored).toBeTruthy();
    expect(restored!.origin).toBe('third_party');
    expect(restored!.imported_from?.package_name).toBe('trip');
    expect(restored!.imported_from?.version).toBe('2');
    expect(restored!.script).toContain('user block');
  });

  it('rejects malformed zip with 400', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/import'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/blocks/import`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: { zip_base64: Buffer.from('not actually a zip').toString('base64') },
      },
    );
    expect(res.status).toBe(400);
  });

  it('reports updated count on re-import of same package', async () => {
    const { token } = await setup();
    // Seed a block with id 'source' so the import (which packs it under
    // the same id) registers as "update" on the second run.
    await seedBlock('source');

    const exportRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/blocks/export'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/blocks/export?name=pkg&version=1`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const exported = await exportRes.json() as { zip_base64: string };

    // First import: id collides with the seeded original → counts as update.
    // Second: same again. We assert both are updates (the contract is
    // "id-collision = update").
    for (let i = 0; i < 2; i++) {
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/blocks/import'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/blocks/import`,
        { siteId: SITE },
        { headers: bearer(token), body: { zip_base64: exported.zip_base64 } },
      );
      const body = await res.json() as { created: number; updated: number };
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);
    }
  });
});
