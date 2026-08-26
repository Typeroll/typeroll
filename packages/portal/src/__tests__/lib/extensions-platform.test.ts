import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, type ExtensionManifest } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import {
  createExtension,
  installExtension,
  publishExtensionVersion,
  reviewPublicExtension,
  saveExtensionVersion,
  updateExtensionDistribution,
  updateExtensionInstallation,
  setExtensionVersionLifecycle,
  setExtensionInstallationStatus,
  uninstallExtension,
} from '../../lib/extensions/registry';
import { buildExtensionRuntimeSnapshot } from '../../lib/extensions/runtime-snapshot';
import {
  exchangeExtensionLaunchCode,
  issueExtensionLaunchGrant,
  rotateInstallationCredential,
  authenticateInstallationCredential,
  extensionIssuerDiscovery,
  verifyDelegatedExtensionToken,
  verifyPublicExtensionToken,
} from '../../lib/extensions/auth';
import { issuePublicExtensionToken } from '../../lib/extensions/public-token';
import { verifyExtensionAssets } from '../../lib/extensions/assets';
import { pairExtensionIssuer, trustedExtensionIssuerId } from '../../lib/extensions/trust-pairing';
import { deliverExtensionLifecycleEvent } from '../../lib/extensions/events';
import { requireApiKey } from '../../lib/api-auth';

const DEV_ORG = 'developer';
const OWNER_ORG = 'customer';
const SITE = 'site-one';
const SCRIPT = 'export function mount() {}';
const SCRIPT_DIGEST = crypto.createHash('sha256').update(SCRIPT).digest('hex');

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schema_version: 3,
    id: 'se.vendor.quote-generator',
    name: 'Quote Generator',
    version: '1.0.0',
    runtime_compatibility: '>=0.38.0 <1.0.0',
    distribution: 'private',
    developer: {
      name: 'Vendor AB',
      support_url: 'https://vendor.example/support',
      privacy_url: 'https://vendor.example/privacy',
    },
    permissions: [
      { scope: 'content:read', reason: 'Reads products.' },
      { scope: 'content:write', reason: 'Stores approved quote references.' },
    ],
    config_schema: {
      type: 'object',
      properties: {
        price_list_id: { type: 'string', public: true },
        internal_queue: { type: 'string' },
        api_secret: { type: 'string', format: 'secret' },
      },
      required: ['price_list_id', 'api_secret'],
    },
    frontend: {
      components: [{
        id: 'calculator', label: 'Quote calculator', render_mode: 'bundled_component',
        props_schema: { type: 'object', properties: { heading: { type: 'string' } } },
        url_context: { fragment: [{ name: 't', expose_as: 'customer_token', sensitive: true, consume: true }] },
        entry: { script_url: 'https://93.184.216.34/quote.js', script_sha256: SCRIPT_DIGEST },
      }],
    },
    admin: { pages: [{ id: 'quotes', label: 'Quotes', launch_url: 'https://vendor.example/launch', minimum_permission: 'write' }] },
    api: {
      base_url: 'https://93.184.216.34/typeroll',
      authentication: 'signed_installation',
      routes: [{ path: '/quotes/*', methods: ['GET', 'POST'] }],
    },
    ...overrides,
  };
}

async function registeredInstallation() {
  const created = await createExtension({
    developerOrgId: DEV_ORG,
    actorId: 'developer-user',
    id: 'se.vendor.quote-generator',
    name: 'Quote Generator',
    trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'],
    allowedSiteIds: [SITE],
  });
  await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, actorId: 'developer-user', manifest: manifest() });
  await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, version: '1.0.0', verifyAssets: async () => {} });
  const installation = await installExtension({
    developerOrgId: DEV_ORG,
    ownerOrgId: OWNER_ORG,
    siteId: SITE,
    actorId: 'customer-admin',
    extensionId: created.extension.id,
    version: '1.0.0',
    grantedScopes: ['content:read', 'content:write'],
    config: { price_list_id: 'prices-eu', internal_queue: 'quotes', api_secret: 'secret-value' },
  });
  return { created, installation };
}

describe('Extension control plane', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
    process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
    delete process.env.FORMS_PUBLIC_URL;
    process.env.FORMS_HMAC_SECRET = 'forms-secret-key-longer-than-thirty-two-characters';
    delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  });

  it('registers, publishes, installs and provisions a private component', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    const blocks = await getStore().listDocs(paths.blockTypes(OWNER_ORG, SITE));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      extension: { installation_id: installation.id, component_id: 'calculator' },
    });

    const snapshot = await buildExtensionRuntimeSnapshot(OWNER_ORG, SITE);
    expect(snapshot.installations).toEqual([
      expect.objectContaining({
        installation_id: installation.id,
        public_config: { price_list_id: 'prices-eu' },
        components: [expect.objectContaining({ local_script_url: expect.stringContaining('/_assets/extensions/') })],
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    expect(JSON.stringify(snapshot)).not.toContain('internal_queue');

    await getStore().setDoc(paths.site(OWNER_ORG, SITE), { name: 'Customer site', hosting_adapter: 'cloudflare', created_at: new Date().toISOString() });
    await getStore().setDoc(paths.page(OWNER_ORG, SITE, 'quote'), {
      title: 'Quote', slug: 'quote', status: 'published', content_mode: 'html',
      html_content: `<x-extension block="${String(blocks[0]!.id)}" props='{&quot;heading&quot;:&quot;Personal quote&quot;}' />`,
    });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(OWNER_ORG, SITE, 'quote', 'main');
    expect(html).toContain(`data-tr-extension-installation="${installation.id}"`);
    expect(html).toContain('Personal quote');
    expect(html).not.toContain('<x-extension');
  });

  it('projects signed form capabilities only when the submit scope was granted', async () => {
    const withForms = manifest({
      config_schema: undefined,
      permissions: [
        { scope: 'content:read', reason: 'Reads products.' },
        { scope: 'forms:submit', reason: 'Stores quote leads.' },
      ],
      frontend: {
        components: [{
          id: 'calculator', label: 'Quote calculator', render_mode: 'bundled_component',
          form_bindings: [{ id: 'lead', form_id: 'quote-leads' }],
          entry: { script_url: 'https://93.184.216.34/quote.js', script_sha256: SCRIPT_DIGEST },
        }],
      },
    });
    const created = await createExtension({
      developerOrgId: DEV_ORG, actorId: 'developer-user', id: withForms.id,
      name: withForms.name, trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'], allowedSiteIds: [SITE],
    });
    await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, actorId: 'developer-user', manifest: withForms });
    await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, version: withForms.version, verifyAssets: async () => {} });
    const installation = await installExtension({
      developerOrgId: DEV_ORG, ownerOrgId: OWNER_ORG, siteId: SITE,
      actorId: 'customer-admin', extensionId: created.extension.id, version: withForms.version,
      grantedScopes: ['content:read', 'forms:submit'], config: {},
    });

    const component = (await buildExtensionRuntimeSnapshot(OWNER_ORG, SITE)).installations[0]!.components[0]!;
    expect(component.resolved_form_bindings?.lead).toMatchObject({
      form_id: 'quote-leads',
      submit_url: 'https://admin.customer.example/api/forms/submit',
      submit_token: expect.stringContaining(`${OWNER_ORG}.${SITE}.quote-leads.`),
      pow_bits: 15,
    });

    await updateExtensionInstallation({
      ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id,
      actorId: 'customer-admin', grantedScopes: ['content:read'], config: {},
    });
    const revoked = (await buildExtensionRuntimeSnapshot(OWNER_ORG, SITE)).installations[0]!.components[0]!;
    expect(revoked.resolved_form_bindings).toBeUndefined();
  });

  it('supports the CLI flow through org-scoped developer and installation APIs', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({ orgId: DEV_ORG, siteId: null, name: 'Extension CLI', createdBy: 'developer-user' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const developerIndex = await import('../../pages/api/developer/extensions/index');
    const registered = await developerIndex.POST({
      request: new Request('https://portal.example/api/developer/extensions', {
        method: 'POST', headers, body: JSON.stringify({
          id: 'se.vendor.quote-generator', name: 'Quote Generator', distribution: 'private',
          trusted_origins: ['https://vendor.example', 'https://93.184.216.34'],
        }),
      }), cookies: {} as never,
    } as never);
    expect(registered.status).toBe(201);

    const versions = await import('../../pages/api/developer/extensions/[extensionId]/versions/index');
    const saved = await versions.POST({
      request: new Request('https://portal.example/api/developer/extensions/se.vendor.quote-generator/versions', {
        method: 'POST', headers, body: JSON.stringify({ manifest: manifest() }),
      }), cookies: {} as never, params: { extensionId: 'se.vendor.quote-generator' },
    } as never);
    expect(saved.status).toBe(201);

    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(DEV_ORG, SITE), { name: 'CLI test site', hosting_adapter: 'cloudflare', created_at: new Date().toISOString() });
    const installationApi = await import('../../pages/api/v1/sites/[siteId]/extensions');
    const installed = await installationApi.POST({
      request: new Request(`https://portal.example/api/v1/sites/${SITE}/extensions`, {
        method: 'POST', headers, body: JSON.stringify({
          extension_id: 'se.vendor.quote-generator', version: '1.0.0',
          granted_scopes: ['content:read'],
          config: { price_list_id: 'test', api_secret: 'secret-value' },
        }),
      }), params: { siteId: SITE },
    } as never);
    expect(installed.status).toBe(201);
  });

  it('lets the developer organization install and update its own draft versions', async () => {
    await createExtension({
      developerOrgId: DEV_ORG,
      actorId: 'developer-user',
      id: 'se.vendor.quote-generator',
      name: 'Quote Generator',
      distribution: 'public',
      trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'],
    });
    await saveExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      actorId: 'developer-user',
      manifest: manifest({ distribution: 'public' }),
    });
    const installation = await installExtension({
      developerOrgId: DEV_ORG,
      ownerOrgId: DEV_ORG,
      siteId: SITE,
      actorId: 'developer-user',
      extensionId: 'se.vendor.quote-generator',
      version: '1.0.0',
      grantedScopes: ['content:read'],
      config: { price_list_id: 'draft', api_secret: 'secret-value' },
    });
    await saveExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      actorId: 'developer-user',
      manifest: manifest({ distribution: 'public', version: '1.0.1' }),
    });
    await expect(updateExtensionInstallation({
      ownerOrgId: DEV_ORG,
      siteId: SITE,
      installationId: installation.id,
      actorId: 'developer-user',
      version: '1.0.1',
    })).resolves.toMatchObject({ version: '1.0.1' });
  });

  it('keeps draft and review versions unavailable to customer organizations', async () => {
    const publicManifest = manifest({ distribution: 'public' });
    await createExtension({
      developerOrgId: DEV_ORG,
      actorId: 'developer-user',
      id: publicManifest.id,
      name: publicManifest.name,
      distribution: 'public',
      trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'],
    });
    await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, actorId: 'developer-user', manifest: publicManifest });
    const installForCustomer = () => installExtension({
      developerOrgId: DEV_ORG,
      ownerOrgId: OWNER_ORG,
      siteId: SITE,
      actorId: 'customer-admin',
      extensionId: publicManifest.id,
      version: publicManifest.version,
      grantedScopes: ['content:read'],
      config: { price_list_id: 'customer', api_secret: 'secret-value' },
    });
    await expect(installForCustomer()).rejects.toMatchObject({ status: 404 });
    await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, version: publicManifest.version, verifyAssets: async () => {} });
    await expect(installForCustomer()).rejects.toMatchObject({ status: 404 });
  });

  it('changes distribution only while every saved version is a draft', async () => {
    await createExtension({
      developerOrgId: DEV_ORG,
      actorId: 'developer-user',
      id: 'se.vendor.quote-generator',
      name: 'Quote Generator',
      trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'],
    });
    const firstDraft = await saveExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      actorId: 'developer-user',
      manifest: manifest(),
    });
    const updated = await updateExtensionDistribution({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      distribution: 'public',
    });
    expect(updated.distribution).toBe('public');
    const { getStore } = await import('../../lib/datastore');
    const rewritten = await getStore().getDoc<import('@typeroll/shared').ExtensionVersion>(
      paths.extensionVersion(DEV_ORG, 'se.vendor.quote-generator', '1.0.0'),
    );
    expect(rewritten?.manifest.distribution).toBe('public');
    expect(rewritten?.manifest_sha256).not.toBe(firstDraft.manifest_sha256);
    const submitted = await publishExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      version: '1.0.0',
      verifyAssets: async () => {},
    });
    expect(submitted.status).toBe('review');
    await expect(updateExtensionDistribution({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      distribution: 'private',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects undeclared execution origins and invalid distributions', async () => {
    await expect(createExtension({
      developerOrgId: DEV_ORG,
      actorId: 'developer-user',
      id: 'se.vendor.invalid-distribution',
      name: 'Invalid',
      distribution: 'other' as 'private',
    })).rejects.toMatchObject({ status: 400 });

    await createExtension({
      developerOrgId: DEV_ORG,
      actorId: 'developer-user',
      id: 'se.vendor.quote-generator',
      name: 'Quote Generator',
      trustedOrigins: ['https://vendor.example'],
    });
    await expect(saveExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      actorId: 'developer-user',
      manifest: manifest(),
    })).rejects.toThrow('unregistered execution origins: https://93.184.216.34');
  });

  it('makes published versions immutable', async () => {
    await registeredInstallation();
    await expect(saveExtensionVersion({
      developerOrgId: DEV_ORG,
      extensionId: 'se.vendor.quote-generator',
      actorId: 'developer-user',
      manifest: manifest({ name: 'Changed in place' }),
    })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps page instances while removing provisioned definitions on uninstall', async () => {
    const { installation } = await registeredInstallation();
    await uninstallExtension({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'customer-admin' });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.blockTypes(OWNER_ORG, SITE))).toEqual([]);
    expect(await getStore().getDoc(paths.extensionInstallation(OWNER_ORG, SITE, installation.id))).toMatchObject({ status: 'revoked' });
  });

  it('removes disabled installations from the public snapshot immediately', async () => {
    const { installation } = await registeredInstallation();
    await setExtensionInstallationStatus({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'customer-admin', status: 'disabled' });
    expect((await buildExtensionRuntimeSnapshot(OWNER_ORG, SITE)).installations).toEqual([]);
  });

  it('fails deployment snapshots closed for installed manifest v1 records', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    const versionPath = paths.extensionVersion(DEV_ORG, installation.extension_id, installation.version);
    const version = await getStore().getDoc<any>(versionPath);
    await getStore().updateDoc(versionPath, {
      schema_version: 1,
      manifest: { ...version.manifest, schema_version: 1 },
    });

    await expect(buildExtensionRuntimeSnapshot(OWNER_ORG, SITE)).rejects.toThrow(
      'uses unsupported manifest schema 1; reinstall a release using schema 3',
    );
  });

  it('holds public releases for operator review before catalog discovery', async () => {
    const publicManifest = manifest({ distribution: 'public' });
    await createExtension({ developerOrgId: DEV_ORG, actorId: 'developer-user', id: publicManifest.id, name: publicManifest.name, distribution: 'public', trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'] });
    await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, actorId: 'developer-user', manifest: publicManifest });
    const submitted = await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, version: publicManifest.version, verifyAssets: async () => {} });
    expect(submitted.status).toBe('review');
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.extensionCatalogEntry(publicManifest.id))).toMatchObject({ status: 'in_review' });
    const approved = await reviewPublicExtension({ extensionId: publicManifest.id, approve: true, reviewerId: 'operator' });
    expect(approved.status).toBe('published');
    expect(await getStore().getDoc(paths.extensionVersion(DEV_ORG, publicManifest.id, publicManifest.version))).toMatchObject({ status: 'published' });
  });

  it('keeps distribution locked after a public review rejection returns the version to draft', async () => {
    const publicManifest = manifest({ distribution: 'public' });
    await createExtension({ developerOrgId: DEV_ORG, actorId: 'developer-user', id: publicManifest.id, name: publicManifest.name, distribution: 'public', trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'] });
    await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, actorId: 'developer-user', manifest: publicManifest });
    await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: publicManifest.id, version: publicManifest.version, verifyAssets: async () => {} });
    await reviewPublicExtension({ extensionId: publicManifest.id, approve: false, reviewerId: 'operator', note: 'Needs changes' });
    await expect(updateExtensionDistribution({
      developerOrgId: DEV_ORG,
      extensionId: publicManifest.id,
      distribution: 'private',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('deprecates and irreversibly revokes an immutable version', async () => {
    await registeredInstallation();
    expect((await setExtensionVersionLifecycle({ developerOrgId: DEV_ORG, extensionId: 'se.vendor.quote-generator', version: '1.0.0', status: 'deprecated' })).status).toBe('deprecated');
    expect((await setExtensionVersionLifecycle({ developerOrgId: DEV_ORG, extensionId: 'se.vendor.quote-generator', version: '1.0.0', status: 'revoked', reason: 'Security issue' })).status).toBe('revoked');
    await expect(setExtensionVersionLifecycle({ developerOrgId: DEV_ORG, extensionId: 'se.vendor.quote-generator', version: '1.0.0', status: 'deprecated' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('Extension identities', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
    process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
    delete process.env.SITES_BASE_DOMAIN;
    delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  });

  it('atomically redeems a launch code once and signs permission-intersected claims', async () => {
    const { created, installation } = await registeredInstallation();
    const launch = await issueExtensionLaunchGrant({
      ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id,
      userId: 'editor-one', permission: 'write', minimumPermission: 'write',
    });
    const exchange = () => exchangeExtensionLaunchCode({ code: launch.code, clientId: created.extension.client_id, clientSecret: created.client_secret });
    const results = await Promise.allSettled([exchange(), exchange()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const successful = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof exchange>>> => result.status === 'fulfilled')!;
    const claims = verifyDelegatedExtensionToken(successful.value.access_token, installation.extension_id);
    expect(claims).toMatchObject({ sub: 'editor-one', site_id: SITE, installation_id: installation.id, permission: 'write' });
    expect(claims.scopes).toEqual(['content:read', 'content:write']);
  });

  it('rotates a distinct service credential and honors its grace window', async () => {
    const { installation } = await registeredInstallation();
    const first = await rotateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', now: new Date('2026-01-01T00:00:00Z') });
    const second = await rotateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', graceSeconds: 60, now: new Date('2026-01-01T00:01:00Z') });
    await expect(authenticateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, credential: first.credential, now: new Date('2026-01-01T00:01:30Z') })).resolves.toBeTruthy();
    await expect(authenticateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, credential: first.credential, now: new Date('2026-01-01T00:02:01Z') })).rejects.toMatchObject({ status: 401 });
    await expect(authenticateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, credential: second.credential, now: new Date('2026-01-01T00:02:01Z') })).resolves.toBeTruthy();
  });

  it('enforces the central REST scope map for installation credentials', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(OWNER_ORG, SITE), { name: 'Customer site', hosting_adapter: 'cloudflare', created_at: new Date().toISOString() });
    const { credential } = await rotateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin' });
    const headers = { Authorization: `Bearer ${credential}`, 'X-Typeroll-Organization-Id': OWNER_ORG, 'X-Typeroll-Installation-Id': installation.id };
    const read = await requireApiKey(new Request(`https://portal.example/api/v1/sites/${SITE}/pages`, { headers }), SITE);
    expect(read.ok).toBe(true);
    const formsWrite = await requireApiKey(new Request(`https://portal.example/api/v1/sites/${SITE}/forms`, { method: 'POST', headers }), SITE);
    expect(formsWrite.ok).toBe(false);
    if (!formsWrite.ok) expect(formsWrite.response.status).toBe(403);
  });
});

describe('Extension assets and direct provider API', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
    process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  });

  it('rejects a bundle whose bytes no longer match the published digest', async () => {
    const fakeFetch = vi.fn(async () => new Response('changed bytes', { status: 200 }));
    await expect(verifyExtensionAssets(manifest(), fakeFetch as typeof fetch)).rejects.toThrow('SHA-256 mismatch');
  });

  it('issues an origin-bound short-lived installation token without proxying a provider request', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(OWNER_ORG, SITE), {
      name: 'Customer site', domain: 'customer.example', hosting_adapter: 'cloudflare', created_at: new Date().toISOString(),
    });
    const result = await issuePublicExtensionToken({
      request: new Request('https://admin.customer.example/api/extensions/public-token', {
        method: 'POST', headers: { Origin: 'https://customer.example' },
      }),
      orgId: OWNER_ORG,
      siteId: SITE,
      installationId: installation.id,
    });
    expect(result.cors['Access-Control-Allow-Origin']).toBe('https://customer.example');
    expect(extensionIssuerDiscovery()).toMatchObject({
      protocol_version: 3,
      provider_api_transport: 'direct',
      public_extension_token_endpoint: expect.stringContaining('/api/extensions/public-token/'),
    });
    expect(verifyPublicExtensionToken(result.token, installation.extension_id)).toMatchObject({
      token_use: 'public_extension',
      origin: 'https://customer.example',
      site_id: SITE,
      installation_id: installation.id,
    });
    await expect(issuePublicExtensionToken({
      request: new Request('https://admin.customer.example/api/extensions/public-token', {
        method: 'POST', headers: { Origin: 'https://attacker.example' },
      }),
      orgId: OWNER_ORG,
      siteId: SITE,
      installationId: installation.id,
    })).rejects.toMatchObject({ status: 403 });
  });

  it('accepts the deterministic fallback origin when an older site has no stored fallback hostname', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.com';
    await getStore().setDoc(paths.site(OWNER_ORG, SITE), {
      name: 'Fallback site', slug: 'fallback-demo', hosting_adapter: 'cloudflare', created_at: new Date().toISOString(),
    });
    const result = await issuePublicExtensionToken({
      request: new Request('https://admin.customer.example/api/extensions/public-token', {
        method: 'POST', headers: { Origin: 'https://fallback-demo.sites.typeroll.com' },
      }),
      orgId: OWNER_ORG,
      siteId: SITE,
      installationId: installation.id,
    });
    expect(result.cors['Access-Control-Allow-Origin']).toBe('https://fallback-demo.sites.typeroll.com');
  });

  it('pairs a self-host issuer only after the provider echoes nonce and JWKS fingerprint', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    const versionPath = paths.extensionVersion(DEV_ORG, installation.extension_id, installation.version);
    const version = await getStore().getDoc<any>(versionPath);
    await getStore().updateDoc(versionPath, { manifest: { ...version.manifest, auth: { pairing_url: 'https://93.184.216.34/pair' } } });
    const fakeFetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ trusted: true, issuer: input.issuer, nonce: input.nonce, jwks_fingerprint: input.jwks_fingerprint }), { status: 200 });
    });
    const paired = await pairExtensionIssuer({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', fetchImpl: fakeFetch as typeof fetch });
    expect(paired).toMatchObject({ status: 'trusted', issuer: 'https://admin.customer.example' });
  });

  it('shows whether the current Typeroll issuer is already trusted in site settings', async () => {
    const orgId = 'default';
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(orgId, SITE), {
      name: 'Extension settings test',
      hosting_adapter: 'cloudflare',
      created_at: new Date().toISOString(),
    });
    const created = await createExtension({
      developerOrgId: orgId,
      actorId: 'dev-user',
      id: 'se.vendor.quote-generator',
      name: 'Quote Generator',
      trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'],
    });
    await saveExtensionVersion({
      developerOrgId: orgId,
      extensionId: created.extension.id,
      actorId: 'dev-user',
      manifest: manifest({ auth: { pairing_url: 'https://93.184.216.34/pair' } }),
    });
    await publishExtensionVersion({
      developerOrgId: orgId,
      extensionId: created.extension.id,
      version: '1.0.0',
      verifyAssets: async () => {},
    });
    await installExtension({
      developerOrgId: orgId,
      ownerOrgId: orgId,
      siteId: SITE,
      actorId: 'dev-user',
      extensionId: created.extension.id,
      version: '1.0.0',
      grantedScopes: ['content:read'],
      config: { price_list_id: 'test', api_secret: 'secret-value' },
    });
    const pairedAt = '2026-08-25T10:00:00.000Z';
    const issuer = 'https://admin.customer.example';
    await getStore().setDoc(
      paths.trustedExtensionIssuer(orgId, created.extension.id, trustedExtensionIssuerId(issuer)),
      {
        extension_id: created.extension.id,
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        jwks_fingerprint: 'fingerprint',
        status: 'trusted',
        paired_at: pairedAt,
        created_at: pairedAt,
      },
    );

    const route = await import('../../pages/api/sites/[siteId]/extensions/index');
    const response = await route.GET({
      request: new Request(`https://admin.customer.example/api/sites/${SITE}/extensions`),
      cookies: { get: () => undefined },
      params: { siteId: SITE },
      locals: {},
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.extensions).toEqual([
      expect.objectContaining({ issuer_trust: { status: 'trusted', paired_at: pairedAt } }),
    ]);
  });

  it('signs lifecycle events without including config or customer payloads', async () => {
    const { installation } = await registeredInstallation();
    const { getStore } = await import('../../lib/datastore');
    const versionPath = paths.extensionVersion(DEV_ORG, installation.extension_id, installation.version);
    const version = await getStore().getDoc<any>(versionPath);
    await getStore().updateDoc(versionPath, { manifest: { ...version.manifest, events: { subscriptions: ['extension.updated'], webhook_url: 'https://93.184.216.34/events', secret_config_key: 'api_secret' } } });
    const fakeFetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const payload = String(init?.body);
      expect(payload).not.toContain('secret-value');
      expect(payload).not.toContain('prices-eu');
      expect(new Headers(init?.headers).get('x-typeroll-signature')).toMatch(/^v1=/);
      return new Response(null, { status: 204 });
    });
    await deliverExtensionLifecycleEvent({ installation, eventType: 'extension.updated', metadata: { from_version: '0.9.0' }, fetchImpl: fakeFetch as typeof fetch });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});
