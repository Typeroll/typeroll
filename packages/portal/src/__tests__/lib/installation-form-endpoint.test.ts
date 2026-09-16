import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  installation: { id: 'installed', status: 'enabled' } as any,
  version: { manifest: { api: { base_url: 'https://provider.example/v1', routes: [{ path: '/session', methods: ['POST', 'GET'] }] } } } as any,
}));
const getDoc = vi.hoisted(() => vi.fn(async (_path: string) => state.installation));
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ getDoc }) }));
vi.mock('../../lib/forms-signing', () => ({ formEmbedInfo: vi.fn() }));
vi.mock('../../lib/extensions/auth', () => ({ extensionIssuer: () => 'https://cms.example' }));
vi.mock('../../lib/extensions/resolution', () => ({ resolveExtensionVersion: async () => ({ version: state.version }) }));
import { installedFormEmbedInfo, resolveAppFormEndpoint, validInstallationFormTarget } from '../../lib/apps/form-endpoint';
const args = { orgId: 'org', siteId: 'site', portalUrl: 'https://cms.example' };
const form = { id: 'form', target: { installation_id: 'installed', path: '/session', hydrate: true, session_param: 't' } } as any;
describe('installed native form endpoints', () => {
  beforeEach(() => { state.installation = { id: 'installed', status: 'enabled' }; getDoc.mockClear(); });
  it('retains the provider base path and binds the declared route to the exact site installation', async () => {
    const endpoint = await resolveAppFormEndpoint(form, args);
    const url = new URL(endpoint!.submit_url);
    expect(url.origin + url.pathname).toBe('https://provider.example/v1/session');
    expect(Object.fromEntries(url.searchParams)).toEqual({ issuer: args.portalUrl, org_id: 'org', site_id: 'site', installation_id: 'installed' });
    expect(getDoc.mock.calls[0]![0]).toContain('organizations/org/sites/site/');
  });
  it('never falls back to a normal form when its app is disabled, missing, undeclared or legacy', async () => {
    state.installation.status = 'disabled';
    await expect(resolveAppFormEndpoint(form, args)).rejects.toThrow('unavailable');
    expect(await installedFormEmbedInfo('org', 'site', form)).toMatchObject({ submit_url: null, unavailable: expect.any(String) });
    state.installation = null;
    await expect(resolveAppFormEndpoint(form, args)).rejects.toThrow('unavailable');
    state.installation = { id: 'installed', status: 'enabled' };
    await expect(resolveAppFormEndpoint({ target: { installation_id: 'installed', path: '/other' } }, args)).rejects.toThrow('not declared');
    await expect(resolveAppFormEndpoint({ target: { app: 'legacy' } } as any, args)).rejects.toThrow('migration');
  });
  it('accepts only a declared installation target shape and rejects authority/URL injection', () => {
    expect(validInstallationFormTarget(form.target)).toBe(true);
    for (const target of [
      { ...form.target, installation_id: '../another' },
      { ...form.target, path: '//evil' },
      { ...form.target, path: '/session?site=another' },
      { ...form.target, authority: 'owner' },
    ]) expect(validInstallationFormTarget(target)).toBe(false);
  });
});
