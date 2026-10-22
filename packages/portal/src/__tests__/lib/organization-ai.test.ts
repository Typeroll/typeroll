// The Organization's own AI key: write-only encrypted storage, verification
// with Anthropic (mocked fetch), Site access and resolution. There is no
// platform key and no environment fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { OrganizationAiSettings } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'org-a';
const OTHER = 'org-b';
const FAKE_KEY = 'sk-ant-api03-FAKE-test-key-not-real-0000WXYZ';
const actor = { userId: 'owner-user', email: 'owner@example.test' };

function anthropicAnswers(status: number) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status }));
}

async function lib() { return import('../../lib/ai/organization-ai'); }
async function store() { return (await import('../../lib/datastore')).getStore(); }

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  const s = await store();
  for (const [org, site] of [[ORG, 'alpha'], [ORG, 'beta'], [OTHER, 'gamma']]) {
    await s.setDoc(paths.site(org, site), { name: site.toUpperCase(), created_at: '2026-01-01' });
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('storing the key', () => {
  it('verifies with Anthropic, stores it encrypted and bound to the organization, and never returns it', async () => {
    const { setAiKey, aiSettingsSummary } = await lib();
    const fetchImpl = anthropicAnswers(200);
    const summary = await setAiKey(ORG, actor, `  ${FAKE_KEY}  `, fetchImpl as never);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe(FAKE_KEY);
    expect((init!.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');

    const stored = await (await store()).getDoc<OrganizationAiSettings>(paths.organizationAiSettings(ORG));
    expect(stored!.encrypted_api_key!.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(FAKE_KEY);
    expect(stored).toMatchObject({ provider: 'anthropic', key_last4: 'WXYZ', key_set_by: 'owner-user', key_set_by_email: 'owner@example.test' });

    // A first key starts with no Sites selected.
    expect(summary).toMatchObject({ configured: true, key: { last4: 'WXYZ', verified: true }, site_access: { mode: 'selected', site_ids: [] } });
    expect(summary.sites.every((site) => !site.ai_enabled)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(summary)).not.toContain(stored!.encrypted_api_key!);
    expect(JSON.stringify(await aiSettingsSummary(ORG))).not.toContain('encrypted');
  });

  it('refuses a key Anthropic rejects and stores nothing', async () => {
    const { setAiKey, readAiSettings } = await lib();
    for (const status of [401, 403]) {
      await expect(setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(status) as never))
        .rejects.toMatchObject({ status: 422, code: 'ai_key_rejected' });
    }
    expect(await readAiSettings(ORG)).toBeNull();
  });

  it('refuses instead of storing an unverified key when Anthropic cannot be reached', async () => {
    const { setAiKey, readAiSettings } = await lib();
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const error = await setAiKey(ORG, actor, FAKE_KEY, offline as never).catch((e) => e);
    expect(error).toMatchObject({ status: 502, code: 'ai_key_unverified' });
    expect(error.message).not.toContain(FAKE_KEY);
    await expect(setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(529) as never)).rejects.toMatchObject({ code: 'ai_key_unverified' });
    expect(await readAiSettings(ORG)).toBeNull();
  });

  it('validates the input and requires encrypted secret storage', async () => {
    const { setAiKey } = await lib();
    const fetchImpl = anthropicAnswers(200);
    await expect(setAiKey(ORG, actor, '', fetchImpl as never)).rejects.toMatchObject({ code: 'api_key_required' });
    await expect(setAiKey(ORG, actor, 'short', fetchImpl as never)).rejects.toMatchObject({ code: 'api_key_invalid_format' });
    await expect(setAiKey(ORG, actor, 'sk-ant with spaces in the middle', fetchImpl as never)).rejects.toMatchObject({ code: 'api_key_invalid_format' });
    vi.stubEnv('INTEGRATIONS_SECRET_KEY', '');
    await expect(setAiKey(ORG, actor, FAKE_KEY, fetchImpl as never)).rejects.toMatchObject({ status: 503, code: 'encryption_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps Site access when the key is replaced and resets it when the key is removed', async () => {
    const { setAiKey, setAiSiteAccess, removeAiKey, readAiSettings } = await lib();
    await setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(200) as never);
    await setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: ['alpha'] });
    const replaced = await setAiKey(ORG, actor, `${FAKE_KEY.slice(0, -4)}NEW1`, anthropicAnswers(200) as never);
    expect(replaced.site_access).toEqual({ mode: 'selected', site_ids: ['alpha'] });
    expect(replaced.key!.last4).toBe('NEW1');
    const removed = await removeAiKey(ORG, actor);
    expect(removed).toMatchObject({ configured: false, key: null, site_access: { mode: 'selected', site_ids: [] } });
    expect((await readAiSettings(ORG))!.encrypted_api_key).toBeNull();
  });
});

describe('Site access', () => {
  it('needs a key, accepts only the organization’s own Sites and validates the shape', async () => {
    const { setAiKey, setAiSiteAccess } = await lib();
    await expect(setAiSiteAccess(ORG, actor, { mode: 'all' })).rejects.toMatchObject({ status: 409, code: 'ai_key_required' });
    await setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(200) as never);
    await expect(setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: ['gamma'] })).rejects.toMatchObject({ code: 'unknown_site' });
    await expect(setAiSiteAccess(ORG, actor, { mode: 'some' })).rejects.toMatchObject({ code: 'invalid_site_access' });
    await expect(setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: 'alpha' })).rejects.toMatchObject({ code: 'invalid_site_access' });
    const summary = await setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: ['beta', 'alpha', 'beta'] });
    expect(summary.site_access).toEqual({ mode: 'selected', site_ids: ['alpha', 'beta'] });
  });
});

describe('resolution', () => {
  it('returns a key only for an allowed Site of the owner organization', async () => {
    const { setAiKey, setAiSiteAccess, removeAiKey, resolveAnthropicKey, isAiEnabledForSite, getAnthropicForSite } = await lib();
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'alpha' })).toBeNull();

    await setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(200) as never);
    // Default: no Sites selected.
    expect(await isAiEnabledForSite({ orgId: ORG, siteId: 'alpha' })).toBe(false);

    await setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: ['alpha'] });
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'alpha' })).toBe(FAKE_KEY);
    expect(await getAnthropicForSite({ orgId: ORG, siteId: 'alpha' })).not.toBeNull();
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'beta' })).toBeNull();
    // Another organization's Site never resolves through this key.
    expect(await resolveAnthropicKey({ orgId: OTHER, siteId: 'gamma' })).toBeNull();

    await setAiSiteAccess(ORG, actor, { mode: 'all' });
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'beta' })).toBe(FAKE_KEY);
    // "All sites" includes Sites created later.
    await (await store()).setDoc(paths.site(ORG, 'later'), { name: 'Later', created_at: '2026-02-01' });
    expect(await isAiEnabledForSite({ orgId: ORG, siteId: 'later' })).toBe(true);

    await removeAiKey(ORG, actor);
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'alpha' })).toBeNull();
    expect(await isAiEnabledForSite({ orgId: ORG, siteId: 'later' })).toBe(false);
  });

  it('refuses a sealed key copied into another organization and never falls back to the environment', async () => {
    const { setAiKey, setAiSiteAccess, readAiSettings, resolveAnthropicKey } = await lib();
    await setAiKey(ORG, actor, FAKE_KEY, anthropicAnswers(200) as never);
    const copied = await readAiSettings(ORG);
    await (await store()).setDoc(paths.organizationAiSettings(OTHER), { ...copied, site_access: { mode: 'all', site_ids: [] } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveAnthropicKey({ orgId: OTHER, siteId: 'gamma' })).toBeNull();

    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_KEY);
    await setAiSiteAccess(ORG, actor, { mode: 'selected', site_ids: [] });
    expect(await resolveAnthropicKey({ orgId: ORG, siteId: 'alpha' })).toBeNull();
  });
});

describe('AI workflow helpers', () => {
  it('fail with ai_not_enabled when the Site has no access', async () => {
    const { generateText } = await import('../../lib/ai/claude');
    await expect(generateText({ orgId: ORG, siteId: 'alpha' }, 'system', 'user')).rejects.toMatchObject({ code: 'ai_not_enabled' });
  });

  it('let the SEO audit fall back to its issue list without AI access', async () => {
    const { seoAuditWorkflow } = await import('../../lib/workflows/seo-audit');
    const logs: string[] = [];
    const audits = [{ page_id: 'p', url: '/p', title: 'P', issues: ['No H1 heading'], score: 50 }];
    const step = seoAuditWorkflow.steps.find((s) => s.name === 'ai_recommendations')!;
    const out = await step.run({ orgId: ORG, siteId: 'alpha', workflowId: 'w', config: {}, state: { audits, overall_score: 50 },
      store: await store(), log: (m: string) => logs.push(m), setProgress: () => {} } as never);
    expect(out).toMatchObject({ results: { recommendations: audits } });
    expect(logs.join('\n')).toContain('Organization settings → AI assistant');
  });
});
