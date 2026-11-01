// The AI crawler policy is an admin-only site setting written as Content
// Signals, like robots_txt.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { buildPagesHeaders, withGlobalHeaders } from '../../lib/deploy/pages-headers';
import { SITE_SETTINGS_SECTION_FIELDS } from '../../lib/site-settings-sections';

let token: string;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Example' });
  await getStore().setDoc(paths.version('org', 'site', MAIN_VERSION_ID), { name: 'Main', kind: 'main' });
  const { createApiKey } = await import('../../lib/api-keys');
  ({ token } = await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'admin' }));
});

async function patch(body: unknown): Promise<Response> {
  const { PATCH } = await import('../../pages/api/v1/sites/[siteId]/settings');
  return PATCH({ params: { siteId: 'site' }, request: new Request('http://localhost/api/v1/sites/site/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

async function stored(): Promise<Record<string, unknown>> {
  const { vstore } = await import('../../lib/version-store');
  return ((await vstore.settings('org', 'site', MAIN_VERSION_ID)) ?? {}) as Record<string, unknown>;
}

describe('ai_crawler_policy setting', () => {
  it('stores a valid policy, rejects others and clears with null', async () => {
    expect((await patch({ ai_crawler_policy: 'no_training' })).status).toBe(200);
    expect((await stored()).ai_crawler_policy).toBe('no_training');
    const rejected = await patch({ ai_crawler_policy: 'block_training' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('allow_all, no_training, block_all');
    expect((await patch({ ai_crawler_policy: null })).status).toBe(200);
    expect((await stored()).ai_crawler_policy).toBeUndefined();
  });

  it('belongs to the SEO section of the portal form', () => {
    expect(SITE_SETTINGS_SECTION_FIELDS.seo).toContain('ai_crawler_policy');
  });

  it('can be sent as a global response header next to the publication defaults', () => {
    const headers = withGlobalHeaders(buildPagesHeaders(), { 'Content-Signal': 'search=yes, ai-input=yes, ai-train=no' });
    expect(headers).toMatch(/^\/\*\n(?:  .*\n)*  Content-Signal: search=yes, ai-input=yes, ai-train=no\n/);
  });
});

describe('page body starters through composition-starters', () => {
  it('returns each marketing page body without saving', async () => {
    const { GET } = await import('../../pages/api/v1/sites/[siteId]/composition-starters');
    for (const kind of ['feature_page', 'comparison_page', 'integration_page', 'pricing_page', 'use_case_page']) {
      const res = await GET({ params: { siteId: 'site' }, request: new Request(`http://localhost/api/v1/sites/site/composition-starters?kind=${kind}`, { headers: { authorization: `Bearer ${token}` } }) } as never) as Response;
      expect(res.status, kind).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ kind, saved: false });
      expect(body.blocks.at(-1).type).toBe('core/cta');
    }
  });
});
