// The portal's New page form names only a title. A taken address is numbered,
// and the editor is told which page already holds the requested slug.

import { beforeEach, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const access = vi.hoisted(() => vi.fn());
vi.mock('../../lib/access', () => ({
  requireSiteAccess: access,
  requirePermission: () => ({ ok: true }),
  json: (body: unknown, status = 200) => Response.json(body, { status }),
}));

import { POST } from '../../pages/api/sites/[siteId]/pages/create';
import { getStore } from '../../lib/datastore';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  access.mockResolvedValue({ ok: true, value: { session: { email: 'editor@example.com' }, site: { id: 'site' }, versionId: MAIN_VERSION_ID, owner_org_id: 'org' } });
  await getStore().setDoc(paths.version('org', 'site', MAIN_VERSION_ID), { name: 'Main', kind: 'main' });
});

async function submit(title: string): Promise<string | null> {
  const form = new FormData();
  form.set('title', title);
  const request = new Request('http://localhost/api/sites/site/pages/create', { method: 'POST', body: form });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  const response = await POST({ request, cookies: {}, redirect, params: { siteId: 'site' }, locals: {} } as never);
  expect(response.status).toBe(302);
  return response.headers.get('location');
}

it('opens the new page without a notice when the derived slug is free', async () => {
  expect(await submit('Tack')).toBe('/app/sites/site/pages/tack');
});

it('numbers a taken derived slug and tells the editor which page holds it', async () => {
  await getStore().setDoc(`${paths.pages('org', 'site', MAIN_VERSION_ID)}/tack`, { title: 'Tack', slug: 'tack', status: 'draft', content_mode: 'html', html_content: '' });
  const location = new URL(await submit('Tack') ?? '', 'http://localhost');
  expect(location.pathname).toBe('/app/sites/site/pages/tack-2');
  expect(Object.fromEntries(location.searchParams)).toEqual({ slug_adjusted: 'tack', conflicting_page_id: 'tack' });
});
