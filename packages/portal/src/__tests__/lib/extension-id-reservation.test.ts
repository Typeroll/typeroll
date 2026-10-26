import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type Extension, type ExtensionInstallation, type ExtensionManifest } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import {
  claimExtensionIdReservation,
  createExtension,
  installExtension,
  publishExtensionVersion,
  saveExtensionVersion,
  updateExtensionDistribution,
} from '../../lib/extensions/registry';
import {
  exchangeExtensionLaunchCode,
  issueExtensionLaunchGrant,
  signDelegatedExtensionToken,
  signInstallationAssertion,
  signIssuerPairingAssertion,
  signPublicExtensionToken,
  verifyDelegatedExtensionToken,
  verifyPublicExtensionToken,
} from '../../lib/extensions/auth';
import { issuePublicExtensionToken } from '../../lib/extensions/public-token';

const VICTIM_ORG = 'victim-developer';
const ATTACKER_ORG = 'attacker-developer';
const OWNER_ORG = 'customer';
const SITE = 'site-one';
const EXTENSION_ID = 'com.victim.app';
const SCRIPT_DIGEST = crypto.createHash('sha256').update('export function mount() {}').digest('hex');
const ORIGINS = ['https://vendor.example', 'https://93.184.216.34'];

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schema_version: 3,
    id: EXTENSION_ID,
    name: 'Victim App',
    version: '1.0.0',
    runtime_compatibility: '>=0.38.0 <1.0.0',
    distribution: 'private',
    developer: { name: 'Victim AB', support_url: 'https://vendor.example/support', privacy_url: 'https://vendor.example/privacy' },
    permissions: [{ scope: 'content:read', reason: 'Reads products.' }],
    frontend: {
      components: [{
        id: 'widget', label: 'Widget', render_mode: 'bundled_component',
        props_schema: { type: 'object', properties: {} },
        entry: { script_url: 'https://93.184.216.34/widget.js', script_sha256: SCRIPT_DIGEST },
      }],
    },
    admin: { pages: [{ id: 'admin', label: 'Admin', launch_url: 'https://vendor.example/launch', minimum_permission: 'write' }] },
    api: {
      base_url: 'https://93.184.216.34/api',
      authentication: 'signed_installation',
      routes: [{ path: '/items/*', methods: ['GET'] }],
    },
    ...overrides,
  };
}

function register(developerOrgId: string) {
  return createExtension({
    developerOrgId, actorId: `${developerOrgId}-user`, id: EXTENSION_ID, name: 'Victim App',
    trustedOrigins: ORIGINS, allowedSiteIds: [`${OWNER_ORG}/${SITE}`],
  });
}

/** An Extension record written before id reservations existed. */
async function legacyRegistration(developerOrgId: string, siteId = SITE): Promise<{ extension: Extension; client_secret: string }> {
  const clientSecret = `tre_legacy_${developerOrgId}`;
  const now = new Date().toISOString();
  const extension: Omit<Extension, 'id'> = {
    developer_org_id: developerOrgId, name: 'Legacy', distribution: 'private', status: 'active',
    allowed_site_ids: [`${OWNER_ORG}/${siteId}`], client_id: `trc_${developerOrgId}`,
    client_secret_hash: crypto.createHash('sha256').update(clientSecret).digest('hex'),
    trusted_origins: ORIGINS, created_at: now, updated_at: now,
  };
  await getStore().setDoc(paths.extension(developerOrgId, EXTENSION_ID), extension);
  return { extension: { id: EXTENSION_ID, ...extension }, client_secret: clientSecret };
}

async function publishAndInstall(developerOrgId: string, siteId = SITE): Promise<ExtensionInstallation> {
  await saveExtensionVersion({ developerOrgId, extensionId: EXTENSION_ID, actorId: 'dev', manifest: manifest() });
  await publishExtensionVersion({ developerOrgId, extensionId: EXTENSION_ID, version: '1.0.0', verifyAssets: async () => {} });
  return installExtension({
    developerOrgId, ownerOrgId: OWNER_ORG, siteId, actorId: 'customer-admin',
    extensionId: EXTENSION_ID, version: '1.0.0', grantedScopes: ['content:read'],
  });
}

function payload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

async function reservationHolder(): Promise<string | undefined> {
  return (await getStore().getDoc<{ developer_org_id: string }>(paths.extensionIdReservation(EXTENSION_ID)))?.developer_org_id;
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  delete process.env.SITES_BASE_DOMAIN;
});

describe('Extension id reservation', () => {
  it('reserves the id on registration and refuses it to another developer organization', async () => {
    await register(VICTIM_ORG);
    expect(await reservationHolder()).toBe(VICTIM_ORG);
    await expect(register(ATTACKER_ORG)).rejects.toMatchObject({ status: 409 });
    expect(await getStore().getDoc(paths.extension(ATTACKER_ORG, EXTENSION_ID))).toBeNull();
    expect(await reservationHolder()).toBe(VICTIM_ORG);
  });

  it('lets only one of two concurrent registrations from different organizations win', async () => {
    const results = await Promise.allSettled([register(VICTIM_ORG), register(ATTACKER_ORG)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('claims idempotently for the owner across create, update and publish', async () => {
    expect(await claimExtensionIdReservation(VICTIM_ORG, EXTENSION_ID)).toBe('claimed');
    expect(await claimExtensionIdReservation(VICTIM_ORG, EXTENSION_ID)).toBe('owned');
    await register(VICTIM_ORG);
    await updateExtensionDistribution({ developerOrgId: VICTIM_ORG, extensionId: EXTENSION_ID, distribution: 'private' });
    await publishAndInstall(VICTIM_ORG);
    expect(await reservationHolder()).toBe(VICTIM_ORG);
    expect(await claimExtensionIdReservation(ATTACKER_ORG, EXTENSION_ID)).toBe('held_by_other');
  });

  it('refuses an id that another organization has in the public catalog', async () => {
    await getStore().setDoc(paths.extensionCatalogEntry(EXTENSION_ID), { extension_id: EXTENSION_ID, developer_org_id: VICTIM_ORG });
    await expect(register(ATTACKER_ORG)).rejects.toMatchObject({ status: 409 });
    expect(await reservationHolder()).toBeUndefined();
  });

  it('keeps legacy duplicate registrations working but refuses new ones', async () => {
    await legacyRegistration(VICTIM_ORG);
    await legacyRegistration(ATTACKER_ORG);
    expect(await reservationHolder()).toBeUndefined();

    // The first organization to update a legacy registration claims the free id.
    await saveExtensionVersion({ developerOrgId: VICTIM_ORG, extensionId: EXTENSION_ID, actorId: 'dev', manifest: manifest() });
    expect(await reservationHolder()).toBe(VICTIM_ORG);

    // The other legacy registration still saves, publishes and installs.
    const legacyInstall = await publishAndInstall(ATTACKER_ORG);
    expect(legacyInstall.developer_org_id).toBe(ATTACKER_ORG);
    expect(await reservationHolder()).toBe(VICTIM_ORG);

    // A new registration of the id is refused, even by the legacy holder
    // after it has removed its own record.
    await expect(register('third-developer')).rejects.toMatchObject({ status: 409 });
    await getStore().deleteDoc(paths.extension(ATTACKER_ORG, EXTENSION_ID));
    await expect(register(ATTACKER_ORG)).rejects.toMatchObject({ status: 409 });
  });
});

describe('developer organization claim on installation tokens', () => {
  it('adds developer_org_id to delegated, public, assertion and pairing tokens without changing aud', async () => {
    const { client_secret, extension } = await register(VICTIM_ORG);
    const installation = await publishAndInstall(VICTIM_ORG);

    const launch = await issueExtensionLaunchGrant({
      ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id,
      userId: 'editor', permission: 'write', minimumPermission: 'write',
    });
    const exchanged = await exchangeExtensionLaunchCode({ code: launch.code, clientId: extension.client_id, clientSecret: client_secret });
    expect(verifyDelegatedExtensionToken(exchanged.access_token, EXTENSION_ID))
      .toMatchObject({ aud: EXTENSION_ID, developer_org_id: VICTIM_ORG, org_id: OWNER_ORG });

    await getStore().setDoc(paths.site(OWNER_ORG, SITE), {
      name: 'Customer site', domain: 'customer.example', hosting_adapter: 'cloudflare', created_at: new Date().toISOString(),
    });
    const publicToken = await issuePublicExtensionToken({
      request: new Request('https://admin.customer.example/api/extensions/public-token', { method: 'POST', headers: { Origin: 'https://customer.example' } }),
      orgId: OWNER_ORG, siteId: SITE, installationId: installation.id,
    });
    expect(verifyPublicExtensionToken(publicToken.token, EXTENSION_ID))
      .toMatchObject({ aud: EXTENSION_ID, developer_org_id: VICTIM_ORG });
    const preview = signPublicExtensionToken({ installation, origin: 'null', previewRoutes: [{ path: '/items/*', methods: ['GET'] }] });
    expect(preview.claims).toMatchObject({ aud: EXTENSION_ID, developer_org_id: VICTIM_ORG, preview: true });

    for (const purpose of ['documentation', 'build_derivation', undefined] as const) {
      const assertion = signInstallationAssertion({ installation, scopes: [], correlationId: 'c', purpose, version: '1.0.0' });
      expect(payload(assertion)).toMatchObject({ aud: EXTENSION_ID, developer_org_id: VICTIM_ORG, token_use: purpose ?? 'installation' });
    }
    expect(payload(signIssuerPairingAssertion({ installation, nonce: 'n' })))
      .toMatchObject({ aud: EXTENSION_ID, developer_org_id: VICTIM_ORG, token_use: 'issuer_pairing' });
  });

  it('distinguishes a legacy duplicate installation by its developer organization', async () => {
    await legacyRegistration(VICTIM_ORG);
    await legacyRegistration(ATTACKER_ORG, 'site-two');
    const victim = await publishAndInstall(VICTIM_ORG);
    const attacker = await publishAndInstall(ATTACKER_ORG, 'site-two');
    const victimClaims = signPublicExtensionToken({ installation: victim, origin: 'https://a.example' }).claims;
    const attackerClaims = signPublicExtensionToken({ installation: attacker, origin: 'https://b.example' }).claims;
    expect(attackerClaims.aud).toBe(victimClaims.aud);
    expect(victimClaims.developer_org_id).toBe(VICTIM_ORG);
    expect(attackerClaims.developer_org_id).toBe(ATTACKER_ORG);
  });

  it('refuses to sign a delegated token without the developer organization', () => {
    expect(() => signDelegatedExtensionToken({
      aud: EXTENSION_ID, sub: 'user', org_id: OWNER_ORG, site_id: SITE, installation_id: 'inst_1',
      permission: 'read', scopes: [],
    } as unknown as Parameters<typeof signDelegatedExtensionToken>[0])).toThrow(/developer organization/);
  });
});

describe('developer extension API', () => {
  it('returns the developer organization id and the id reservation state', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const route = await import('../../pages/api/developer/extensions/[extensionId]/index');
    const read = async (orgId: string) => {
      const { token } = await createApiKey({ orgId, siteId: null, name: 'Developer', createdBy: `${orgId}-user` });
      const response = await route.GET({
        request: new Request(`https://portal.example/api/developer/extensions/${EXTENSION_ID}`, { headers: { Authorization: `Bearer ${token}` } }),
        cookies: {} as never, params: { extensionId: EXTENSION_ID },
      } as never);
      return response.json() as Promise<{ extension: Extension; id_reservation: string }>;
    };
    await legacyRegistration(ATTACKER_ORG);
    await register(VICTIM_ORG);
    expect(await read(VICTIM_ORG)).toMatchObject({ extension: { developer_org_id: VICTIM_ORG }, id_reservation: 'reserved' });
    expect(await read(ATTACKER_ORG)).toMatchObject({ extension: { developer_org_id: ATTACKER_ORG }, id_reservation: 'held_by_other' });
  });
});
