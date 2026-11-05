// E2E persona seeding through the operator API: off unless the portal allows
// it, idempotent, confined to the E2E namespace, and real password sign-in.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadWriteStore } from '../../lib/datastore';
import { createPortalAuth } from '../../lib/identity/portal-auth';
import { createOperatorApi, type OperatorApiMethods, type PersonaSeedRequest } from '../../lib/operator-api';
import { Browser, ORIGIN, memoryStore } from '../helpers/identity';

const SECRET = 'test-auth-secret-0123456789abcdef-0123456789';
const password = (id: string) => `${id}-${'p'.repeat(40)}`;

function request(): PersonaSeedRequest {
  return {
    personas: ['owner', 'pending'].map(persona => ({
      persona, uid: `typeroll-e2e-${persona}`, email: `${persona}@e2e.example.test`, password: password(persona), name: `E2E ${persona}`,
    })),
    documents: [
      { path: 'organizations/e2e-core', data: { name: 'Typeroll E2E Core', roles_enforced: true } },
      { path: 'organizations/e2e-core/members/typeroll-e2e-owner', data: { role: 'owner', firebase_uid: 'typeroll-e2e-owner' } },
      { path: 'organizations/e2e-core/sites/e2e-core-site', data: { name: 'Site', slug: 'e2e-core-site' }, preserve: ['hosting_config'] },
      { path: 'user_organizations/typeroll-e2e-owner', data: { schema_version: 1 } },
      { path: 'user_organizations/typeroll-e2e-owner/organizations/e2e-core', data: { org_id: 'e2e-core' } },
      { path: 'api_key_lookup/aaaaaaaaaaaa', data: { org_id: 'e2e-core', site_id: 'e2e-core-site', key_hash: 'h', is_test_credential: true } },
    ],
  };
}

describe('E2E persona seeding', () => {
  let store: ReadWriteStore;
  let api: OperatorApiMethods;
  const auth = () => createPortalAuth({ secret: SECRET, baseURL: ORIGIN, store: () => store });

  beforeEach(() => {
    store = memoryStore();
    const portal = auth();
    api = createOperatorApi({ store: () => store, auth: () => portal, env: { TYPEROLL_E2E_PERSONA_SEEDING: 'allow' } });
  });

  it('is unavailable unless the portal allows it', async () => {
    const closed = createOperatorApi({ store: () => store, auth, env: {} });
    await expect(closed.seedE2EPersonas(request())).rejects.toThrow(/^operator_api\/not_enabled:/);
    await expect(closed.inspectE2EPersonas({ personas: [], paths: [] })).rejects.toThrow(/not_enabled/);
  });

  it('creates accounts that sign in with their password, idempotently', async () => {
    const first = await api.seedE2EPersonas(request());
    await store.updateDoc('organizations/e2e-core/sites/e2e-core-site', { hosting_config: { pages_project: 'tr-e2e' } });
    const second = await api.seedE2EPersonas(request());
    expect(second.personas).toEqual(first.personas);
    expect(second.personas.every(p => p.exists && p.emailVerified && !p.disabled && p.testAccount && p.passwordValid)).toBe(true);
    expect(await store.listDocs('auth_user')).toHaveLength(2);
    expect((await store.listDocs('auth_account')).filter(a => (a as { providerId?: string }).providerId === 'credential')).toHaveLength(2);
    expect(second.documents['organizations/e2e-core/sites/e2e-core-site']).toMatchObject({ hosting_config: { pages_project: 'tr-e2e' } });

    const browser = new Browser(auth().handler);
    expect((await browser.post('/api/auth/sign-in/email', { email: 'owner@e2e.example.test', password: password('owner') })).status).toBe(200);
  });

  it('replaces a changed password and reports a wrong one', async () => {
    await api.seedE2EPersonas(request());
    const changed = request();
    changed.personas[0]!.password = `rotated-${'q'.repeat(40)}`;
    await api.seedE2EPersonas(changed);
    const inspection = await api.inspectE2EPersonas({ personas: request().personas, paths: [] });
    expect(inspection.personas.map(p => p.passwordValid)).toEqual([false, true]);
  });

  it('re-enables a disabled persona', async () => {
    await api.seedE2EPersonas(request());
    await store.updateDoc('auth_user/typeroll-e2e-owner', { disabled: true });
    const result = await api.seedE2EPersonas(request());
    expect(result.personas[0]).toMatchObject({ disabled: false });
  });

  it('stays inside the E2E namespace', async () => {
    const outside = (path: string, data: Record<string, unknown> = {}) => api.seedE2EPersonas({ personas: [], documents: [{ path, data }] });
    await expect(outside('organizations/customer')).rejects.toThrow(/forbidden_path/);
    await expect(outside('auth_user/typeroll-e2e-owner')).rejects.toThrow(/forbidden_path/);
    await expect(outside('user_organizations/customer/organizations/e2e-core')).rejects.toThrow(/forbidden_path/);
    await expect(outside('api_key_lookup/bbbbbbbbbbbb', { org_id: 'customer', is_test_credential: true })).rejects.toThrow(/test credential/);
    await store.setDoc('api_key_lookup/cccccccccccc', { org_id: 'customer', site_id: 's', key_hash: 'real' });
    await expect(outside('api_key_lookup/cccccccccccc', { org_id: 'e2e-core', is_test_credential: true })).rejects.toThrow(/real credential/);
    expect(await store.getDoc('api_key_lookup/cccccccccccc')).toMatchObject({ org_id: 'customer' });

    const stranger = request();
    stranger.personas = [{ ...stranger.personas[0]!, uid: 'customer-uid' }];
    await expect(api.seedE2EPersonas(stranger)).rejects.toThrow(/invalid_request/);
  });

  it('never takes over an address that belongs to another account', async () => {
    await new Browser(auth().handler).post('/api/auth/sign-up/email', { email: 'owner@e2e.example.test', password: 'correct horse battery', name: 'Real' });
    await expect(api.seedE2EPersonas(request())).rejects.toThrow(/conflict/);
    expect(await store.getDoc('auth_user/typeroll-e2e-owner')).toBeNull();
  });

  it('accepts the complete document set the persona seeder sends', async () => {
    const script = new URL('../../../../../scripts/lib/e2e-personas.mjs', import.meta.url).href;
    const seeder = await import(/* @vite-ignore */ script) as {
      readPersonaManifest(): unknown;
      corePersonas(manifest: unknown): Array<{ id: string; email_env: string; password_env: string }>;
      seedRemotePersonas(input: { services: unknown; env: Record<string, string>; manifest: unknown }): Promise<{ personaCount: number }>;
    };
    const manifest = seeder.readPersonaManifest();
    const env: Record<string, string> = { TYPEROLL_E2E_API_KEY: `typeroll_live_${'a'.repeat(12)}_${'b'.repeat(48)}` };
    for (const persona of seeder.corePersonas(manifest)) {
      env[persona.email_env] = `${persona.id}@e2e.example.test`;
      env[persona.password_env] = password(persona.id);
    }
    const services = { target: 'test', seed: (r: PersonaSeedRequest) => api.seedE2EPersonas(r), inspect: (r: Parameters<OperatorApiMethods['inspectE2EPersonas']>[0]) => api.inspectE2EPersonas(r) };
    expect(await seeder.seedRemotePersonas({ services, env, manifest })).toMatchObject({ personaCount: 5 });
    const browser = new Browser(auth().handler);
    expect((await browser.post('/api/auth/sign-in/email', { email: 'viewer@e2e.example.test', password: password('viewer') })).status).toBe(200);
  });
});
