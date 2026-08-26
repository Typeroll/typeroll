import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';

const ORG = 'testorg';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
}

describe('parseKey', () => {
  it('parses a well-formed token', async () => {
    const { parseKey } = await import('../../lib/api-keys');
    const parsed = parseKey('typeroll_live_abc123def456_0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(parsed).toEqual({
      prefix: 'abc123def456',
      secret: '0123456789abcdef0123456789abcdef0123456789abcdef',
    });
  });

  it('rejects malformed tokens', async () => {
    const { parseKey } = await import('../../lib/api-keys');
    expect(parseKey(null)).toBeNull();
    expect(parseKey('')).toBeNull();
    expect(parseKey('not_a_token')).toBeNull();
    expect(parseKey('typeroll_test_prefix_secret')).toBeNull(); // wrong variant
    expect(parseKey('typeroll_live__secret')).toBeNull();       // empty prefix
    expect(parseKey('typeroll_live_prefix_')).toBeNull();        // empty secret
    expect(parseKey('foo_live_prefix_secret')).toBeNull();   // wrong scheme
  });
});

describe('generateNewKey', () => {
  it('produces unique well-formed tokens', async () => {
    const { generateNewKey, parseKey } = await import('../../lib/api-keys');
    const a = generateNewKey();
    const b = generateNewKey();
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).not.toBe(b.prefix);
    expect(parseKey(a.token)?.prefix).toBe(a.prefix);
    expect(parseKey(a.token)?.secret.length).toBeGreaterThan(20);
  });
});

describe('createApiKey + verifyApiToken round-trip', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('a freshly-created key verifies and returns the right org+site', async () => {
    await setup();
    const { createApiKey, verifyApiToken } = await import('../../lib/api-keys');

    const { key, token } = await createApiKey({
      orgId: ORG,
      siteId: SITE,
      name: 'Acme agency',
      createdBy: 'admin@example.com',
    });
    expect(key.name).toBe('Acme agency');
    expect(token).toMatch(/^typeroll_live_[0-9a-f]{12}_[0-9a-f]{48}$/);

    const verified = await verifyApiToken(token);
    expect(verified).toEqual({ orgId: ORG, siteId: SITE, prefix: key.id });
  });

  it('the secret is not persisted in plaintext', async () => {
    await setup();
    const { createApiKey } = await import('../../lib/api-keys');
    const { getStore } = await import('../../lib/datastore');

    const { token, key } = await createApiKey({
      orgId: ORG,
      siteId: SITE,
      name: 'k',
      createdBy: 'admin@example.com',
    });
    const secret = token.split('_').pop()!;
    const doc = await getStore().getDoc(paths.apiKey(ORG, SITE, key.id));
    expect(JSON.stringify(doc)).not.toContain(secret);
  });

  it('returns null for an unknown token', async () => {
    await setup();
    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken('typeroll_live_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBeNull();
  });

  it('returns null for a malformed token without doing any I/O', async () => {
    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken('garbage')).toBeNull();
    expect(await verifyApiToken('')).toBeNull();
  });

  it('returns null for a tampered secret (correct prefix, wrong tail)', async () => {
    await setup();
    const { createApiKey, verifyApiToken } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: ORG, siteId: SITE, name: 'k', createdBy: 'admin@example.com',
    });
    const [scheme, variant, prefix] = token.split('_');
    const tampered = `${scheme}_${variant}_${prefix}_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    expect(await verifyApiToken(tampered)).toBeNull();
  });
});

describe('revokeApiKey', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('a revoked key stops verifying', async () => {
    await setup();
    const { createApiKey, revokeApiKey, verifyApiToken } = await import('../../lib/api-keys');
    const { key, token } = await createApiKey({
      orgId: ORG, siteId: SITE, name: 'k', createdBy: 'admin@example.com',
    });
    expect(await verifyApiToken(token)).not.toBeNull();

    await revokeApiKey(ORG, SITE, key.id);
    expect(await verifyApiToken(token)).toBeNull();
  });

  it('revoke is idempotent', async () => {
    await setup();
    const { createApiKey, revokeApiKey } = await import('../../lib/api-keys');
    const { key } = await createApiKey({
      orgId: ORG, siteId: SITE, name: 'k', createdBy: 'admin@example.com',
    });
    await revokeApiKey(ORG, SITE, key.id);
    await revokeApiKey(ORG, SITE, key.id);
    // no throw
  });
});

describe('listApiKeys', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('lists active keys first, revoked at the bottom', async () => {
    await setup();
    const { createApiKey, revokeApiKey, listApiKeys } = await import('../../lib/api-keys');
    const a = await createApiKey({ orgId: ORG, siteId: SITE, name: 'a', createdBy: 'admin' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createApiKey({ orgId: ORG, siteId: SITE, name: 'b', createdBy: 'admin' });
    await revokeApiKey(ORG, SITE, a.key.id);

    const all = await listApiKeys(ORG, SITE);
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(b.key.id);
    expect(all[1].id).toBe(a.key.id);
    expect(all[1].revoked_at).toBeTruthy();
  });
});

describe('constantTimeHexEquals', () => {
  it('returns true for matching hex strings', async () => {
    const { constantTimeHexEquals } = await import('../../lib/api-keys');
    expect(constantTimeHexEquals('deadbeef', 'deadbeef')).toBe(true);
  });

  it('returns false for mismatched strings of equal length', async () => {
    const { constantTimeHexEquals } = await import('../../lib/api-keys');
    expect(constantTimeHexEquals('deadbeef', 'deadbeec')).toBe(false);
  });

  it('returns false for strings of different length', async () => {
    const { constantTimeHexEquals } = await import('../../lib/api-keys');
    expect(constantTimeHexEquals('deadbeef', 'deadbeefab')).toBe(false);
  });
});
