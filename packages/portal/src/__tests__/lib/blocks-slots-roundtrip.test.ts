// Regression: slot containers (core/columns, container: 'slots') must be
// populatable through every agent write path. The production bisect against
// gruppsupporter (template 0.14.0) found three broken routes:
//
//  1. add_block with a nested `slots: [[...],[...]]` payload → HTTP 500
//     (Firestore rejects directly-nested arrays — covered at the codec
//     layer by firestore-codec.test.ts; here we defend the fixtures-path
//     semantics + id assignment).
//  2. add_block with parent_id + slot_index → children landed in a flat
//     `children` field the renderer never reads; both columns rendered
//     empty.
//  3. update_page/PATCH with a slots-bearing tree → HTTP 500 (same
//     Firestore root cause).
//
// Each test exercises the actual v1 route handler and then renders the
// page to prove the slot content is visible in the output.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Block, Page, Site, SiteVersion } from '@typeroll/shared';

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
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.body != null ? JSON.stringify(init.body) : undefined,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

const blocksRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]');

async function seedPage(pageId: string, blocks: Block[]): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${pageId}`, {
    title: pageId, slug: pageId, status: 'draft', content_mode: 'blocks', blocks,
  });
}

/** Buffer model: mutations land in the working copy — commit = the explicit Save. */
async function saveDraft(pageId: string): Promise<void> {
  const { commitWorkingCopy } = await import('../../lib/working-copy');
  await commitWorkingCopy(
    { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
    { kind: 'page', id: pageId },
    'test',
  );
}

async function readPage(pageId: string): Promise<Page | null> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${pageId}`);
}

async function renderPage(pageId: string): Promise<string> {
  const { renderPreviewBySlug } = await import('../../lib/render-preview');
  const res = await renderPreviewBySlug(ORG, SITE, [pageId], MAIN_VERSION_ID, {});
  expect(res).toBeTypeOf('string');
  return res as string;
}

/** Extract the inner HTML of each block-columns-col div (renderer output). */
function columnContents(html: string): string[] {
  return [...html.matchAll(/<div class="block-columns-col">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
}

describe('slot containers — agent write paths round-trip', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('path 1: add_block with a nested slots payload persists and renders', async () => {
    const { token } = await setup();
    await seedPage('p1', []);
    const res = await callRoute(blocksRoute(), 'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/p1/blocks`,
      { siteId: SITE, pageId: 'p1' },
      { headers: bearer(token), body: { block: {
        type: 'core/columns', data: { ratio: '1-1' },
        slots: [
          [{ type: 'core/prose', data: { html: '<p>vänster-innehåll</p>' } }],
          [{ type: 'core/prose', data: { html: '<p>höger-innehåll</p>' } }],
        ],
      } } },
    );
    expect(res.status).toBe(200);
    await saveDraft('p1');

    const stored = await readPage('p1');
    const cols = stored!.blocks![0];
    expect(cols.slots).toHaveLength(2);
    // Inner blocks must carry ids (preview crashes on id-less blocks).
    expect(cols.slots![0][0].id).toBeTruthy();
    expect(cols.slots![1][0].id).toBeTruthy();

    const html = await renderPage('p1');
    const colHtml = columnContents(html);
    expect(colHtml[0]).toContain('vänster-innehåll');
    expect(colHtml[1]).toContain('höger-innehåll');
  });

  it('path 2: add_block with parent_id + slot_index targets the RIGHT slot on a slots-less columns instance', async () => {
    const { token } = await setup();
    // The exact persisted shape from production: a columns block with no
    // slots array at all.
    await seedPage('p2', [{ id: 'cols1', type: 'core/columns', data: { ratio: '1-1' } } as Block]);

    for (const [slotIdx, text] of [[0, 'vänster'], [1, 'höger']] as const) {
      const res = await callRoute(blocksRoute(), 'POST',
        `http://localhost/api/v1/sites/${SITE}/pages/p2/blocks`,
        { siteId: SITE, pageId: 'p2' },
        { headers: bearer(token), body: {
          block: { type: 'core/prose', data: { html: `<p>${text}</p>` } },
          parent_id: 'cols1',
          slot_index: slotIdx,
        } },
      );
      expect(res.status).toBe(200);
    }
    await saveDraft('p2');

    const stored = await readPage('p2');
    const cols = stored!.blocks![0];
    expect(cols.children ?? []).toHaveLength(0);
    expect(cols.slots![0][0].data.html).toBe('<p>vänster</p>');
    expect(cols.slots![1][0].data.html).toBe('<p>höger</p>');

    const html = await renderPage('p2');
    const colHtml = columnContents(html);
    expect(colHtml[0]).toContain('vänster');
    expect(colHtml[1]).toContain('höger');
  });

  it('path 3: PATCH page with a slots-bearing tree persists and renders', async () => {
    const { token } = await setup();
    await seedPage('p3', []);
    const res = await callRoute(pageRoute(), 'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/p3`,
      { siteId: SITE, pageId: 'p3' },
      { headers: bearer(token), body: { blocks: [{
        type: 'core/columns', data: {},
        slots: [
          [{ type: 'core/heading', data: { text: 'Patch-vänster', level: 'h2' } }],
          [{ type: 'core/heading', data: { text: 'Patch-höger', level: 'h2' } }],
        ],
      }] } },
    );
    expect(res.status).toBe(200);
    await saveDraft('p3');

    const stored = await readPage('p3');
    expect(stored!.blocks![0].slots).toHaveLength(2);

    const html = await renderPage('p3');
    const colHtml = columnContents(html);
    expect(colHtml[0]).toContain('Patch-vänster');
    expect(colHtml[1]).toContain('Patch-höger');
  });
});
