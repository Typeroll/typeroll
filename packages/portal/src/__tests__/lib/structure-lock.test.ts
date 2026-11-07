/**
 * The structure lock of a handed-over site (SiteSettings.handover with
 * lock_structure). Through the real routes, an editor (no design rights) is
 * refused every write that adds, removes, moves, duplicates or retypes
 * blocks or creates or deletes pages, with 403 { code: 'structure_locked' },
 * while content edits still save. A builder is never locked, nor is an
 * editor while the lock is off. The v1 API (and so MCP) refuses the same
 * through an app installation with content:write. Offline; the dev session
 * is 'dev-user' in organization 'default'.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type Block, type ExtensionManifest, type ExtensionScope, type MemberRole } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { createBlockTemplate } from '../../lib/block-templates-store';
import { mergeWorkingCopy, readWorkingCopy } from '../../lib/working-copy';
import { snapshotRevision } from '../../lib/revisions';
import { blockStructure, sameBlockStructure } from '../../lib/structure-lock';
import { createExtension, installExtension, publishExtensionVersion, saveExtensionVersion } from '../../lib/extensions/registry';
import { rotateInstallationCredential } from '../../lib/extensions/auth';

const ORG = 'default', SITE = 'client', PAGE = 'home';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;
type Route = Record<string, APIRoute>;
const TREE: Block[] = [
  { id: 'hero', type: 'core/section', data: {}, children: [{ id: 'title', type: 'core/heading', data: { text: 'Welcome', level: 'h1' } }] },
  { id: 'body', type: 'core/prose', data: { html: '<p>Text</p>' } },
];

async function seed(role: MemberRole, lock = true, org = ORG) {
  const store = getStore();
  await store.setDoc(paths.org(org), { name: 'Client org', slug: org, plan: 'free', created_at: '', roles_enforced: true });
  await store.setDoc(`${paths.members(org)}/dev-user`, { email: 'dev@typeroll.local', role, firebase_uid: 'dev-user', joined_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(paths.site(org, SITE), { name: 'Client', hosting_adapter: 'cloudflare', created_at: '' });
  await store.setDoc(paths.version(org, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '', robots_blocked: false });
  await store.setDoc(paths.settings(org, SITE, MAIN_VERSION_ID), { site_name: 'Client', fonts: { heading: 'Inter', body: 'Inter' }, handover: { lock_structure: lock, start_page: PAGE } });
  await store.setDoc(paths.page(org, SITE, PAGE, MAIN_VERSION_ID), { title: 'Home', slug: '', status: 'published', content_type: 'page', content_mode: 'blocks', blocks: TREE });
  await vstore.writePageTemplate(org, SITE, MAIN_VERSION_ID, 'landing', { name: 'landing', label: 'Landing', applies_to: 'any', status: 'published', blocks: [{ id: 'slot', type: 'template/content_slot', data: {} }] } as never);
  await createBlockTemplate({ orgId: org, siteId: SITE }, { id: 'band', name: 'Band', blocks: [{ id: 'b', type: 'core/prose', data: { html: '<p>Band</p>' } }] });
}

async function call(route: () => Promise<unknown>, method: string, init: { body?: unknown; form?: Record<string, string>; params?: Record<string, string>; query?: string } = {}): Promise<Response> {
  const handlers = await route() as Route;
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (init.form) { const form = new FormData(); for (const [key, value] of Object.entries(init.form)) form.set(key, value); body = form; }
  else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
  const request = new Request(`http://localhost/api/sites/${SITE}/x${init.query ?? ''}`, { method, headers, body });
  return handlers[method]!({ request, cookies, params: { siteId: SITE, pageId: PAGE, ...(init.params ?? {}) }, locals: {}, redirect: (to: string) => new Response(null, { status: 302, headers: { location: to } }) } as never) as Promise<Response>;
}

const blocks = () => import('../../pages/api/sites/[siteId]/pages/[pageId]/blocks');
const reusable = () => import('../../pages/api/sites/[siteId]/pages/[pageId]/blocks/reusable');
const workingCopy = () => import('../../pages/api/sites/[siteId]/working-copy/[...target]');
const page = () => import('../../pages/api/sites/[siteId]/pages/[pageId]');
const create = () => import('../../pages/api/sites/[siteId]/pages/create');
const mode = () => import('../../pages/api/sites/[siteId]/pages/[pageId]/mode');
const contentType = () => import('../../pages/api/sites/[siteId]/pages/[pageId]/content-type');
const revisions = () => import('../../pages/api/sites/[siteId]/pages/[pageId]/revisions');
const copy = () => import('../../pages/api/sites/[siteId]/clipboard/copy');
const paste = () => import('../../pages/api/sites/[siteId]/clipboard/paste');
const templates = () => import('../../pages/api/sites/[siteId]/templates/index');
const partial = () => import('../../pages/api/sites/[siteId]/partials/[partialId]');

async function expectLocked(response: Promise<Response>, label: string) {
  const res = await response;
  expect(res.status, label).toBe(403);
  expect(((await res.json()) as { code?: string }).code, label).toBe('structure_locked');
}
const draftTree = async () => ((await readWorkingCopy({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, { kind: 'page', id: PAGE }))?.fields?.blocks ?? (await vstore.page(ORG, SITE, MAIN_VERSION_ID, PAGE))?.blocks) as Block[];

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
});

describe('block structure', () => {
  it('is ids, types and nesting, not content', () => {
    const edited = structuredClone(TREE);
    edited[0].children![0].data.text = 'Hello';
    edited[1].name = 'Intro';
    expect(sameBlockStructure(TREE, edited)).toBe(true);
    expect(sameBlockStructure(TREE, [TREE[1], TREE[0]])).toBe(false);
    expect(sameBlockStructure(TREE, [TREE[0]])).toBe(false);
    expect(sameBlockStructure(TREE, [{ ...TREE[0], type: 'core/container' }, TREE[1]])).toBe(false);
    expect(sameBlockStructure(TREE, [{ ...TREE[0], children: [] }, TREE[1]])).toBe(false);
    expect(blockStructure([{ id: 'g', type: 'core/global_block', data: { global_block_id: 'a' } }])).not.toBe(blockStructure([{ id: 'g', type: 'core/global_block', data: { global_block_id: 'b' } }]));
  });
});

describe('an editor on a locked site', () => {
  it('is refused every structural block write and keeps content edits', async () => {
    await seed('editor');
    await expectLocked(call(blocks, 'POST', { body: { block: { type: 'core/prose', data: { html: '<p>New</p>' } } } }), 'add');
    await expectLocked(call(blocks, 'POST', { body: { duplicate_of: 'body' } }), 'duplicate');
    await expectLocked(call(blocks, 'PUT', { body: { block_id: 'body', target_parent_id: null, target_position: 0 } }), 'move');
    await expectLocked(call(blocks, 'DELETE', { query: '?block_id=body' }), 'delete');
    for (const action of [{ action: 'insert_template', template_id: 'band' }, { action: 'make_global', block_id: 'body', name: 'Body' }, { action: 'detach', block_id: 'body' }]) {
      await expectLocked(call(reusable, 'POST', { body: action }), action.action);
    }
    const edit = await call(blocks, 'PATCH', { body: { block_id: 'title', data: { text: 'Hello' } } });
    expect(edit.status).toBe(200);
    expect(sameBlockStructure(await draftTree(), TREE)).toBe(true);
    expect(JSON.stringify(await draftTree())).toContain('Hello');
  });

  it('saves a draft and commits it when only the content changed, not otherwise', async () => {
    await seed('editor');
    const edited = structuredClone(TREE);
    edited[1].data.html = '<p>New text</p>';
    expect((await call(workingCopy, 'PUT', { params: { target: `page/${PAGE}` }, body: { fields: { blocks: edited, title: 'Start' } } })).status).toBe(200);
    await expectLocked(call(workingCopy, 'PUT', { params: { target: `page/${PAGE}` }, body: { fields: { blocks: [TREE[0]] } } }), 'draft without a block');
    await expectLocked(call(workingCopy, 'PUT', { params: { target: `page/${PAGE}` }, body: { fields: { template: 'landing' } } }), 'other page template');
    const commit = await call(workingCopy, 'POST', { params: { target: `page/${PAGE}` } });
    expect(commit.status).toBe(200);
    expect(JSON.stringify((await vstore.page(ORG, SITE, MAIN_VERSION_ID, PAGE))?.blocks)).toContain('New text');
    // A structural draft written before the lock (or by a builder) is not committed by an editor.
    await mergeWorkingCopy({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, { kind: 'page', id: PAGE }, { blocks: [TREE[1]] });
    await expectLocked(call(workingCopy, 'POST', { params: { target: `page/${PAGE}` } }), 'commit');
  });

  it('is refused page creation, deletion, mode and type changes, structural saves and restores', async () => {
    await seed('editor');
    await expectLocked(call(create, 'POST', { form: { title: 'New page' } }), 'create');
    await expectLocked(call(page, 'DELETE'), 'delete page');
    await expectLocked(call(mode, 'POST', { body: { to: 'html' } }), 'mode');
    await expectLocked(call(contentType, 'POST', { body: { content_type: 'article' } }), 'content type');
    await expectLocked(call(page, 'PUT', { body: { blocks: [TREE[0]] } }), 'save without a block');
    await expectLocked(call(page, 'PUT', { body: { template: 'landing' } }), 'page template');
    const edited = structuredClone(TREE);
    edited[1].data.html = '<p>Saved text</p>';
    expect((await call(page, 'PUT', { body: { blocks: edited, title: 'Home' } })).status).toBe(200);
    const revId = await snapshotRevision({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, kind: 'page', resourceIds: [PAGE], doc: { title: 'Home', slug: '', content_mode: 'blocks', blocks: [TREE[1]] }, createdBy: 't' });
    await expectLocked(call(revisions, 'POST', { body: { revId } }), 'restore');
    await expectLocked(call(templates, 'POST', { body: { name: 'other', label: 'Other', blocks: [] } }), 'new page template');
    await getStore().setDoc(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID), { name: 'Footer', kind: 'footer', status: 'published', content_mode: 'blocks', blocks: [{ id: 'f', type: 'core/prose', data: { html: '<p>F</p>' } }] });
    await expectLocked(call(partial, 'PUT', { params: { partialId: 'footer' }, body: { blocks: [] } }), 'global block structure');
    expect((await call(partial, 'PUT', { params: { partialId: 'footer' }, body: { blocks: [{ id: 'f', type: 'core/prose', data: { html: '<p>Footer text</p>' } }] } })).status).toBe(200);
    expect(await vstore.page(ORG, SITE, MAIN_VERSION_ID, PAGE)).toBeTruthy();
  });

  it('copies blocks but is refused pasting them', async () => {
    await seed('editor');
    const copied = await call(copy, 'POST', { body: { page_id: PAGE, block_ids: ['body'] } });
    expect(copied.status).toBe(200);
    const { clipboard_text } = await copied.json() as { clipboard_text: string };
    await expectLocked(call(paste, 'POST', { body: { clipboard: clipboard_text, page_id: PAGE } }), 'paste');
    expect(sameBlockStructure(await draftTree(), TREE)).toBe(true);
  });
});

describe('who is not locked', () => {
  it('a builder changes the structure of a locked site', async () => {
    await seed('builder');
    expect((await call(blocks, 'POST', { body: { block: { type: 'core/prose', data: { html: '<p>New</p>' } } } })).status).toBe(200);
    expect((await call(reusable, 'POST', { body: { action: 'insert_template', template_id: 'band' } })).status).toBe(200);
    expect((await call(create, 'POST', { form: { title: 'New page' } })).status).toBe(302);
  });

  it('an editor while the lock is off', async () => {
    await seed('editor', false);
    expect((await call(blocks, 'POST', { body: { block: { type: 'core/prose', data: { html: '<p>New</p>' } } } })).status).toBe(200);
    expect((await call(blocks, 'DELETE', { query: '?block_id=body' })).status).toBe(200);
  });
});

describe('the v1 API with an app installation (content:write)', () => {
  const OWNER = 'customer';
  async function headers() {
    const id = 'se.vendor.content';
    const scopes: ExtensionScope[] = ['content:read', 'content:write'];
    const manifest: ExtensionManifest = {
      schema_version: 3, id, name: id, version: '1.0.0', runtime_compatibility: '>=0.38.0 <1.0.0', distribution: 'private',
      developer: { name: 'Vendor AB', support_url: 'https://vendor.example/support', privacy_url: 'https://vendor.example/privacy' },
      permissions: scopes.map(scope => ({ scope, reason: `Needs ${scope}.` })),
      api: { base_url: 'https://93.184.216.34/typeroll', authentication: 'signed_installation', routes: [{ path: '/hooks', methods: ['POST'] }] },
    };
    const created = await createExtension({ developerOrgId: 'vendor', actorId: 'dev', id, name: id, trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'], allowedSiteIds: [`${OWNER}/${SITE}`] });
    await saveExtensionVersion({ developerOrgId: 'vendor', extensionId: created.extension.id, actorId: 'dev', manifest });
    await publishExtensionVersion({ developerOrgId: 'vendor', extensionId: created.extension.id, version: '1.0.0', verifyAssets: async () => {} });
    const installation = await installExtension({ developerOrgId: 'vendor', ownerOrgId: OWNER, siteId: SITE, actorId: 'admin', extensionId: created.extension.id, version: '1.0.0', grantedScopes: scopes, config: {} });
    const { credential } = await rotateInstallationCredential({ ownerOrgId: OWNER, siteId: SITE, installationId: installation.id, actorId: 'admin' });
    return { authorization: `Bearer ${credential}`, 'x-typeroll-organization-id': OWNER, 'x-typeroll-installation-id': installation.id, 'content-type': 'application/json' };
  }
  async function v1(route: () => Promise<unknown>, method: string, path: string, auth: Record<string, string>, body?: unknown, params: Record<string, string> = {}) {
    const handlers = await route() as Route;
    return handlers[method]!({ request: new Request(`https://portal.example/api/v1/sites/${SITE}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }), params: { siteId: SITE, pageId: PAGE, ...params }, cookies, locals: {} } as never) as Promise<Response>;
  }

  it('refuses structural writes with structure_locked and keeps content writes', async () => {
    await seed('owner', true, OWNER);
    const auth = await headers();
    const v1Blocks = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
    await expectLocked(v1(v1Blocks, 'POST', `/pages/${PAGE}/blocks`, auth, { block: { type: 'core/prose', data: {} } }), 'v1 add');
    await expectLocked(v1(v1Blocks, 'DELETE', `/pages/${PAGE}/blocks?block_id=body`, auth), 'v1 delete');
    await expectLocked(v1(() => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/duplicate'), 'POST', `/pages/${PAGE}/blocks/duplicate`, auth, { block_id: 'body' }), 'v1 duplicate');
    await expectLocked(v1(() => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/insert-template'), 'POST', `/pages/${PAGE}/blocks/insert-template`, auth, { template_id: 'band' }), 'v1 insert template');
    await expectLocked(v1(() => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index'), 'POST', `/containers/page/${PAGE}/blocks`, auth, { block: { type: 'core/prose', data: {} } }, { kind: 'page', id: PAGE }), 'v1 container add');
    await expectLocked(v1(() => import('../../pages/api/v1/sites/[siteId]/pages/index'), 'POST', '/pages', auth, { title: 'New' }), 'v1 create page');
    await expectLocked(v1(() => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'), 'PATCH', `/pages/${PAGE}`, auth, { blocks: [TREE[1]] }), 'v1 page tree');
    expect((await v1(v1Blocks, 'PATCH', `/pages/${PAGE}/blocks`, auth, { block_id: 'title', data: { text: 'Hi' } })).status).toBe(200);
    const edited = structuredClone(TREE);
    edited[1].data.html = '<p>From the app</p>';
    expect((await v1(() => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'), 'PATCH', `/pages/${PAGE}`, auth, { blocks: edited, save: true })).status).toBe(200);
    expect(JSON.stringify((await vstore.page(OWNER, SITE, MAIN_VERSION_ID, PAGE))?.blocks)).toContain('From the app');
  });
});
