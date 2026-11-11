// App contracts in the control plane: the trusted-developer gate, contract
// releases (save, publish, contract breaks), installation and resolution
// within and across contracts, optional permissions, the runtime snapshot,
// variants, default markup at publication, and forms on the contract address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, extensionMarkupKey, type ExtensionInstallation, type ExtensionManifest, type FrozenExtensionMarkup } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const transport = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: unknown; token: string }>, answer: vi.fn() }));
vi.mock('../../lib/extensions/admin-request', async (load) => {
  const actual = await load<typeof import('../../lib/extensions/admin-request')>();
  return {
    ...actual,
    requestApprovedAdmin: async (url: URL, input: { body?: unknown }, token: string) => {
      transport.calls.push({ url: url.href, body: input.body, token });
      return transport.answer(url.href, input.body);
    },
  };
});

import {
  createExtension, installExtension, publishExtensionVersion, saveExtensionVersion, updateExtensionInstallation,
} from '../../lib/extensions/registry';
import { resolveExtensionVersion } from '../../lib/extensions/resolution';
import { buildExtensionRuntimeSnapshot } from '../../lib/extensions/runtime-snapshot';
import { verifyExtensionAssets } from '../../lib/extensions/assets';
import { ContractCallError, listExtensionVariants } from '../../lib/extensions/contract-calls';
import { collectContractMounts, prepareExtensionMarkup } from '../../lib/extensions/contract-markup';
import { extensionBlockType } from '../../lib/extensions/provision';
import { resolveAppFormEndpoint } from '../../lib/apps/form-endpoint';
import { publicationConfigDigest } from '../../lib/publishing/derivation-providers';
import { TRUSTED_APP_DEVELOPERS_ENV } from '../../lib/extensions/trusted-developers';
import { signCredentialProvisioningAssertion, signDelegatedExtensionToken, signInstallationAssertion, signPublicExtensionToken, contractClaim } from '../../lib/extensions/auth';

const DEV = 'typeroll-apps';
const OWNER = 'customer';
const SITE = 'site-one';
const ID = 'com.typeroll.recurring-events';
const BASE = 'https://events.typeroll.example/c1';

function manifest(version: string, patch: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schema_version: 3, id: ID, name: 'Recurring Events', version, runtime_compatibility: '>=0.38.0 <1.0.0', distribution: 'private', contract: 1,
    developer: { name: 'Typeroll', support_url: 'https://typeroll.example/support', privacy_url: 'https://typeroll.example/privacy' },
    permissions: [{ scope: 'content:read', reason: 'Reads pages.' }, { scope: 'email:send', reason: 'Reminders.', optional: true }],
    frontend: { components: [{ id: 'next-occurrence', label: 'Next occurrence', render_mode: 'contract_component',
      entry: { module_url: `${BASE}/next-occurrence.js` }, variants: { path: '/variants' }, default_markup: { path: '/default-markup' } }] },
    api: { base_url: BASE, authentication: 'signed_installation', routes: [{ path: '/register', methods: ['POST'] }] },
    ...patch,
  };
}

async function release(version: string, patch: Partial<ExtensionManifest> = {}) {
  await saveExtensionVersion({ developerOrgId: DEV, extensionId: ID, actorId: 'dev', manifest: manifest(version, patch) });
  return publishExtensionVersion({ developerOrgId: DEV, extensionId: ID, version, verifyAssets: async () => {} });
}

async function register() {
  await createExtension({ developerOrgId: DEV, actorId: 'dev', id: ID, name: 'Recurring Events',
    trustedOrigins: ['https://events.typeroll.example', 'https://typeroll.example'], allowedSiteIds: [`${OWNER}/${SITE}`] });
}

async function install(version = '0.2.0', grantedScopes: ExtensionInstallation['granted_scopes'] = ['content:read', 'email:send']) {
  return installExtension({ developerOrgId: DEV, ownerOrgId: OWNER, siteId: SITE, actorId: 'admin', extensionId: ID, version, grantedScopes });
}

const update = (installationId: string, patch: Record<string, unknown>) =>
  updateExtensionInstallation({ ownerOrgId: OWNER, siteId: SITE, installationId, actorId: 'admin', ...patch });

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  process.env[TRUSTED_APP_DEVELOPERS_ENV] = `other-org, ${DEV}`;
  delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  transport.calls.length = 0;
  transport.answer.mockReset();
});
afterEach(() => { delete process.env[TRUSTED_APP_DEVELOPERS_ENV]; });

describe('trusted developer gate', () => {
  it('refuses contract manifests from organizations that are not trusted, at save and publish', async () => {
    await register();
    delete process.env[TRUSTED_APP_DEVELOPERS_ENV];
    await expect(saveExtensionVersion({ developerOrgId: DEV, extensionId: ID, actorId: 'dev', manifest: manifest('0.2.0') }))
      .rejects.toMatchObject({ status: 403, code: 'contract_developer_untrusted' });
    process.env[TRUSTED_APP_DEVELOPERS_ENV] = DEV;
    await saveExtensionVersion({ developerOrgId: DEV, extensionId: ID, actorId: 'dev', manifest: manifest('0.2.0') });
    process.env[TRUSTED_APP_DEVELOPERS_ENV] = 'other-org';
    await expect(publishExtensionVersion({ developerOrgId: DEV, extensionId: ID, version: '0.2.0', verifyAssets: async () => {} }))
      .rejects.toMatchObject({ code: 'contract_developer_untrusted' });
  });

  it('stops running contract releases when the developer leaves the list', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    expect((await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false })).installations).toHaveLength(1);
    process.env[TRUSTED_APP_DEVELOPERS_ENV] = '';
    expect((await resolveExtensionVersion(installation)).version).toBeNull();
    await expect(installExtension({ developerOrgId: DEV, ownerOrgId: OWNER, siteId: 'site-two', actorId: 'admin', extensionId: ID, version: '0.2.0', grantedScopes: [] }))
      .rejects.toMatchObject({ code: 'contract_developer_untrusted' });
    expect((await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false })).installations).toHaveLength(0);
  });

  it('requires the module origin to be a registered execution origin', async () => {
    await register();
    await expect(saveExtensionVersion({ developerOrgId: DEV, extensionId: ID, actorId: 'dev', manifest: manifest('0.2.0', {
      frontend: { components: [{ id: 'next-occurrence', label: 'Next', render_mode: 'contract_component', entry: { module_url: 'https://cdn.elsewhere.example/m.js' } }] },
    }) })).rejects.toThrow('unregistered execution origins: https://cdn.elsewhere.example');
  });

  it('never fetches or hashes contract modules when verifying assets', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('no network'); });
    await expect(verifyExtensionAssets(manifest('0.2.0'), fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('contract releases', () => {
  it('refuses a release that removes a component or requires a new permission', async () => {
    await register();
    await release('0.2.0');
    await expect(release('0.2.1', { frontend: { components: [] } })).rejects.toMatchObject({ code: 'contract_broken' });
    await expect(release('0.2.2', { permissions: [{ scope: 'content:read', reason: 'r' }, { scope: 'forms:read', reason: 'r' }] }))
      .rejects.toMatchObject({ code: 'contract_broken' });
    // New permissions are fine when optional, and a new contract may change anything.
    await expect(release('0.2.3', { permissions: [{ scope: 'content:read', reason: 'r' }, { scope: 'forms:read', reason: 'r', optional: true }] })).resolves.toMatchObject({ status: 'published' });
    await expect(release('1.0.0', { contract: 2, frontend: { components: [] } })).resolves.toMatchObject({ status: 'published' });
  });
});

describe('installation and resolution', () => {
  it('binds to the contract, grants no optional scope on install and grants it later on request', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    expect(installation.contract).toBe(1);
    expect(installation.granted_scopes).toEqual(['content:read']);
    const granted = await update(installation.id, { grantedScopes: ['content:read', 'email:send'] });
    expect(granted.granted_scopes).toEqual(['content:read', 'email:send']);
  });

  it('follows the newest release of its contract automatically and activates another contract only explicitly', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    await release('0.2.1', { activation_policy: 'explicit' });
    await release('1.0.0', { contract: 2 });
    const within = await resolveExtensionVersion(installation);
    expect(within.version?.version).toBe('0.2.1');
    expect(within.pending_activation_version).toBe('1.0.0');
    await expect(update(installation.id, { version: '0.2.1' })).rejects.toThrow('follows the newest release of contract 1 automatically');
    const moved = await update(installation.id, { version: '1.0.0' });
    expect(moved.contract).toBe(2);
    const after = await resolveExtensionVersion(moved);
    expect(after.version?.version).toBe('1.0.0');
    expect(after.pending_activation_version).toBeUndefined();
  });

  it('keeps an installation without a contract on its releases until the contract is activated', async () => {
    await register();
    await release('0.1.0', { contract: undefined, permissions: [{ scope: 'content:read', reason: 'r' }],
      frontend: { components: [{ id: 'next-occurrence', label: 'Next', render_mode: 'bundled_component', entry: { script_url: `${BASE}/old.js`, script_sha256: 'a'.repeat(64) } }] } });
    const legacy = await install('0.1.0', ['content:read']);
    expect(legacy.contract).toBeUndefined();
    await release('0.2.0');
    const resolution = await resolveExtensionVersion(legacy);
    expect(resolution.version?.version).toBe('0.1.0');
    expect(resolution.pending_activation_version).toBe('0.2.0');
    const activated = await update(legacy.id, { version: '0.2.0' });
    expect(activated.contract).toBe(1);
    expect((await resolveExtensionVersion(activated)).version?.version).toBe('0.2.0');
  });

  it('publishes the contract and stable module in the snapshot and provisions a variant field', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    const snapshot = await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false, strict: true });
    const [runtime] = snapshot.installations;
    expect(runtime).toMatchObject({ contract: 1, version: '0.2.0', api: { base_url: BASE } });
    expect(runtime!.components[0]).toMatchObject({ render_mode: 'contract_component', entry: { module_url: `${BASE}/next-occurrence.js` } });
    expect(runtime!.components[0]).not.toHaveProperty('local_script_url');
    const block = extensionBlockType(installation, manifest('0.2.0'), manifest('0.2.0').frontend!.components[0]!);
    expect(block.schema.map((field) => [field.name, field.type, field.default])).toEqual([['variant', 'text', 'standard'], ['reserve_px', 'number', undefined]]);
    expect(block.schema[0]!.extension_variants).toBe(true);
    expect(block.extension?.render_mode).toBe('contract_component');
  });
});

describe('variants', () => {
  it('asks the app server side with a component_variants assertion', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    transport.answer.mockResolvedValue({ status: 200, data: { variants: [{ id: 'series-7', label: 'Lunch talks' }, { id: 'standard', label: 'Next event' }] } });
    expect(await listExtensionVariants(OWNER, SITE, installation.id, 'next-occurrence')).toEqual({
      source: 'app', variants: [{ id: 'series-7', label: 'Lunch talks' }, { id: 'standard', label: 'Next event' }],
    });
    expect(transport.calls[0]!.url).toBe(`${BASE}/variants`);
    expect(transport.calls[0]!.body).toEqual({ component_id: 'next-occurrence' });
    const claims = JSON.parse(Buffer.from(transport.calls[0]!.token.split('.')[1]!, 'base64url').toString());
    expect(claims).toMatchObject({ token_use: 'component_variants', installation_id: installation.id, version: '0.2.0', contract: 1, scopes: [] });
  });

  it('lists standard without a declared call and fails clearly when the app does not answer', async () => {
    await register();
    await release('0.2.0', { frontend: { components: [{ id: 'next-occurrence', label: 'Next', render_mode: 'contract_component', entry: { module_url: `${BASE}/n.js` } }] } });
    const installation = await install();
    expect(await listExtensionVariants(OWNER, SITE, installation.id, 'next-occurrence')).toEqual({ source: 'standard', variants: [{ id: 'standard', label: 'Standard' }] });
    expect(transport.calls).toHaveLength(0);
    await release('0.2.1');
    transport.answer.mockRejectedValue(new Error('timeout'));
    await expect(listExtensionVariants(OWNER, SITE, installation.id, 'next-occurrence')).rejects.toThrow('timeout');
    transport.answer.mockResolvedValue({ status: 200, data: { variants: [{ id: 'bad id' }] } });
    await expect(listExtensionVariants(OWNER, SITE, installation.id, 'next-occurrence')).rejects.toBeInstanceOf(ContractCallError);
  });
});

describe('default markup at publication', () => {
  const js = Buffer.from('export const a = 1;').toString('base64');
  const css = Buffer.from('.ev{color:red}').toString('base64');
  async function site() {
    await register();
    await release('0.2.0');
    const installation = await install();
    const snapshot = await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false, strict: true });
    const type = snapshot.installations[0]!.components[0]!.block_type_id;
    const frozen = {
      settings: { language: 'sv' },
      pages: [
        { id: 'p1', language: 'sv', blocks: [{ id: 'b', type: 'core/section', data: {}, children: [{ id: 'm', type, data: { variant: 'lunch-page' } }] }] },
        { id: 'p2', language: 'en', content_mode: 'html', html_content: `<x-extension block="${type}" variant="series-7" />` },
      ],
      partials: [{ id: 'footer', blocks: [{ id: 'f', type, data: {} }] }],
    };
    return { installation, snapshot, frozen };
  }

  it('collects every mount by component, variant and page language', async () => {
    const { snapshot, frozen } = await site();
    const { mounts, defaultLanguage } = collectContractMounts(frozen, snapshot);
    expect(defaultLanguage).toBe('sv');
    expect([...mounts.values()][0]!.size).toBe(4);
    expect([...[...mounts.values()][0]!.keys()].sort()).toEqual([
      'next-occurrence|lunch-page|sv', 'next-occurrence|series-7|en', 'next-occurrence|standard|en', 'next-occurrence|standard|sv',
    ]);
  });

  it('calls the app once and freezes markup, content-addressed files and styles', async () => {
    const { installation, snapshot, frozen } = await site();
    transport.answer.mockImplementation(async (_url: string, body: { mounts: Array<{ key: string }> }) => ({ status: 200, data: {
      markup: Object.fromEntries(body.mounts.map((mount) => [mount.key, `<div class="ev">${mount.key}</div><script type="module" src="{{asset:ev.js}}"></script>`])),
      assets: [{ name: 'ev.js', content_type: 'text/javascript', body_base64: js }, { name: 'ev.css', content_type: 'text/css', body_base64: css },
        { name: 'ev.js', content_type: 'text/javascript', body_base64: js }],
      styles: ['ev.css'],
    } }));
    const result = await prepareExtensionMarkup({ orgId: OWNER, siteId: SITE, frozen, snapshot, prior: null });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url).toBe(`${BASE}/default-markup`);
    expect((transport.calls[0]!.body as { mounts: unknown[] }).mounts).toContainEqual({ key: 'next-occurrence|lunch-page|sv', component_id: 'next-occurrence', variant: 'lunch-page', language: 'sv' });
    expect(JSON.parse(Buffer.from(transport.calls[0]!.token.split('.')[1]!, 'base64url').toString()).token_use).toBe('default_markup');
    expect(result.warnings).toEqual([]);
    const app = result.markup!.apps[installation.id]!;
    expect(app.assets).toHaveLength(2);
    expect(app.assets[0]!.path).toMatch(/^\/_assets\/apps\/com-typeroll-recurring-events\/[a-f0-9]{16}\/ev\.js$/);
    expect(app.markup['next-occurrence|lunch-page|sv']).toBe(`<div class="ev">next-occurrence|lunch-page|sv</div><script type="module" src="${app.assets[0]!.path}"></script>`);
    expect(app.styles).toEqual([app.assets[1]!.path]);
  });

  it.each([
    ['an unsupported type', { name: 'x.html', content_type: 'text/html', body_base64: js }],
    ['a path as name', { name: '../x.js', content_type: 'text/javascript', body_base64: js }],
    ['an oversized file', { name: 'big.js', content_type: 'text/javascript', body_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
  ])('treats %s as a failed answer', async (_label, asset) => {
    const { snapshot, frozen } = await site();
    transport.answer.mockResolvedValue({ status: 200, data: { markup: {}, assets: [asset] } });
    const result = await prepareExtensionMarkup({ orgId: OWNER, siteId: SITE, frozen, snapshot, prior: null });
    expect(result.warnings[0]).toMatch(/^extension_default_markup_unavailable: com\.typeroll\.recurring-events/);
  });

  it('reuses the previous publication\'s markup, files and styles when the app fails, else leaves mounts empty', async () => {
    const { installation, snapshot, frozen } = await site();
    const asset = { path: '/_assets/apps/com-typeroll-recurring-events/0123456789abcdef/ev.css', content_type: 'text/css', body_base64: css };
    const prior: { extension_markup: FrozenExtensionMarkup } = { extension_markup: { format: 1, default_language: 'sv', apps: { [installation.id]: {
      extension_id: ID, markup: { [extensionMarkupKey('next-occurrence', 'lunch-page', 'sv')]: '<p>Förra</p>', 'next-occurrence|gone|sv': '<p>Gammal</p>' },
      assets: [asset], styles: [asset.path] } } } };
    transport.answer.mockRejectedValue(new Error('timeout'));
    const reused = await prepareExtensionMarkup({ orgId: OWNER, siteId: SITE, frozen, snapshot, prior });
    expect(reused.markup!.apps[installation.id]).toEqual({ extension_id: ID, markup: { 'next-occurrence|lunch-page|sv': '<p>Förra</p>' }, assets: [asset], styles: [asset.path] });
    expect(reused.warnings).toEqual([`extension_default_markup_unavailable: ${ID} (${installation.id}): timeout. Reused the previous publication's markup for 1 of 4 mounts.`]);
    const empty = await prepareExtensionMarkup({ orgId: OWNER, siteId: SITE, frozen, snapshot, prior: null });
    expect(empty.markup!.apps).toEqual({});
    expect(empty.warnings[0]).toContain('Its 4 mounts stay empty until the app answers.');
  });

  it('changes nothing for a site without contract mounts', async () => {
    const { snapshot } = await site();
    expect(await prepareExtensionMarkup({ orgId: OWNER, siteId: SITE, frozen: { pages: [] }, snapshot })).toEqual({ warnings: [] });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('contract claim', () => {
  const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  const base = { id: 'inst', extension_id: ID, developer_org_id: DEV, owner_org_id: OWNER, site_id: SITE, granted_scopes: [] } as unknown as ExtensionInstallation;

  it('names the contract next to the resolved version in every installation proof, and only for contract installations', () => {
    for (const [installation, expected] of [[{ ...base, contract: 2 }, 2], [base, undefined]] as const) {
      const proofs = [
        signInstallationAssertion({ installation, scopes: [], correlationId: 'c', purpose: 'form_action', version: '1.4.0' }),
        signInstallationAssertion({ installation, scopes: [], correlationId: 'c', purpose: 'build_derivation', version: '1.4.0' }),
        signCredentialProvisioningAssertion({ installation, version: '1.4.0', credentialSha256: 'a'.repeat(64) }),
        signPublicExtensionToken({ installation, origin: 'https://site.example' }).token,
        signDelegatedExtensionToken({ token_use: 'portal_admin', version: '1.4.0', aud: ID, sub: 'u', org_id: OWNER, site_id: SITE,
          developer_org_id: DEV, installation_id: 'inst', permission: 'admin', scopes: [], ...contractClaim(installation) }).token,
      ].map(claims);
      for (const proof of proofs) {
        if (expected === undefined) expect(proof).not.toHaveProperty('contract');
        else expect(proof.contract).toBe(expected);
      }
      expect(proofs[0]!.version).toBe('1.4.0');
    }
  });
});

describe('forms and derivations', () => {
  it('posts forms to the contract address and keeps the resolved release in the config digest', async () => {
    await register();
    await release('0.2.0');
    const installation = await install();
    const endpoint = await resolveAppFormEndpoint({ id: 'signup', target: { installation_id: installation.id, path: '/register' } },
      { orgId: OWNER, siteId: SITE, portalUrl: 'https://admin.customer.example' });
    expect(endpoint!.submit_url.startsWith(`${BASE}/register?`)).toBe(true);
    const before = publicationConfigDigest(await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false }).then((extensions) => ({ extensions })));
    await release('0.2.1');
    const after = publicationConfigDigest(await buildExtensionRuntimeSnapshot(OWNER, SITE, { reconcileBlocks: false }).then((extensions) => ({ extensions })));
    expect(after).not.toBe(before);
    const { getStore } = await import('../../lib/datastore');
    expect((await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(OWNER, SITE, installation.id)))!.version).toBe('0.2.0');
  });
});
