// The admin email-connector route encrypts secrets, masks them on read, and
// gates on admin permission. Cookie-auth dev session lands in org 'default'.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site, SiteIntegrations } from '@typeroll/shared';

const ORG = 'default';
const SITE = 'mysite';

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'unit-test-integrations-key-please-change-32+chars';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
}

// The dev session (no Firebase) is admin on org 'default'. requireSiteAccess
// reads cookies via a stub; loadSiteContext uses the dev fallback.
const cookies = { get: () => undefined } as any;
const locals = {} as any;

async function callPut(body: unknown): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/integrations/email');
  const req = new Request(`http://localhost/api/sites/${SITE}/integrations/email`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return mod.PUT({ request: req, cookies, params: { siteId: SITE }, locals } as any) as Promise<Response>;
}
async function callGet(): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/integrations/email');
  const req = new Request(`http://localhost/api/sites/${SITE}/integrations/email`);
  return mod.GET({ request: req, cookies, params: { siteId: SITE }, locals } as any) as Promise<Response>;
}

describe('integrations/email admin route', () => {
  beforeEach(async () => { await setup(); });

  it('encrypts the SMTP password and masks it on read', async () => {
    const put = await callPut({
      type: 'smtp', from: 'Site <a@b.com>',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: 'u', password: 'super-secret' },
    });
    expect(put.status).toBe(200);

    // Stored password is ciphertext, never plaintext.
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(ORG, SITE));
    const enc = doc!.email!.config.password_enc as string;
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('super-secret');
    const { decryptSecret } = await import('../../lib/secret-crypto');
    expect(decryptSecret(enc)).toBe('super-secret');
    // Non-secret fields stored plainly.
    expect(doc!.email!.config.host).toBe('smtp.x.com');
    expect(doc!.email!.config.port).toBe(587);

    // GET never returns the secret.
    const got = await (await callGet()).json();
    expect(got.email.config.password.set).toBe(true);
    expect(got.providers.map((p: { type: string }) => p.type)).toContain('postmark');
    expect(JSON.stringify(got)).not.toContain('super-secret');
  });

  it('keeps the stored secret when the mask sentinel is re-sent', async () => {
    await callPut({
      type: 'smtp', from: 'Site <a@b.com>',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: 'u', password: 'pw1' },
    });
    // Re-save with no new password (UI echoes the mask).
    await callPut({
      type: 'smtp', from: 'Updated <a@b.com>',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: 'u', password: '••••••••' },
    });
    const { getStore } = await import('../../lib/datastore');
    const { decryptSecret } = await import('../../lib/secret-crypto');
    const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(ORG, SITE));
    expect(decryptSecret(doc!.email!.config.password_enc as string)).toBe('pw1');
    expect(doc!.email!.from).toBe('Updated <a@b.com>');
  });

  it('rejects an unknown connector type', async () => {
    const res = await callPut({ type: 'mailgun', from: 'a@b.com', config: {} });
    expect(res.status).toBe(400);
  });

  it('requires a Postmark token on first save', async () => {
    const res = await callPut({ type: 'postmark', from: 'a@b.com', config: {} });
    expect(res.status).toBe(400);
  });

  it('503s when the encryption key is unconfigured', async () => {
    delete process.env.INTEGRATIONS_SECRET_KEY;
    const res = await callPut({
      type: 'smtp', from: 'a@b.com',
      config: { host: 'h', port: 25, secure: false, user: '', password: 'x' },
    });
    expect(res.status).toBe(503);
  });
});
