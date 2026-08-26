// contact.address accepts both freeform string AND a structured
// PostalAddress object. Renderer-side JSON-LD emission is a separate
// enhancement; this test only covers storage round-trip.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function patch(token: string, body: Record<string, unknown>): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/settings');
  const handler = mod.PATCH as APIRoute;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return handler({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

describe('contact.address — both shapes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('stores a freeform string verbatim', async () => {
    const { token } = await setup();
    await patch(token, { contact: { address: 'Main Street 12, 10001 New York' } });
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.contact?.address).toBe('Main Street 12, 10001 New York');
  });

  it('stores a structured PostalAddress object', async () => {
    const { token } = await setup();
    await patch(token, {
      contact: {
        address: {
          street_address: 'Storgatan 5',
          postal_code: '11432',
          address_locality: 'Stockholm',
          address_country: 'SE',
        },
      },
    });
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    const addr = settings?.contact?.address as { street_address: string; postal_code: string };
    expect(addr.street_address).toBe('Storgatan 5');
    expect(addr.postal_code).toBe('11432');
  });

  it('can be changed from string to object via PATCH (replacement, not deep merge)', async () => {
    const { token } = await setup();
    // Start with a string
    await patch(token, { contact: { address: 'Old freeform' } });
    // Switch to structured
    await patch(token, {
      contact: {
        address: { street_address: 'New Street 1', postal_code: '00001', address_locality: 'Anywhere' },
      },
    });
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    const addr = settings?.contact?.address;
    expect(typeof addr).toBe('object');
    expect((addr as { postal_code: string }).postal_code).toBe('00001');
  });
});
