// The portal's own workflow routes share lib/workflows/service with the
// public API: the polling read masks credentials and drops internal state,
// and approval is refused unless the run is paused for review.

import { beforeEach, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const resumed = vi.hoisted(() => [] as string[]);
vi.mock('../../lib/workflows/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workflows/engine')>();
  return {
    WorkflowEngine: class extends actual.WorkflowEngine {
      override async start() { return {} as never; }
      override async resume(_orgId: string, workflowId: string) { resumed.push(workflowId); return {} as never; }
    },
  };
});

const ORG = 'default'; // dev-session organization
const SITE = 'mysite';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  resumed.length = 0;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: '2026-01-01' });
  await getStore().setDoc(`${paths.workflows(ORG)}/wf_1_run`, {
    site_id: SITE, type: 'migration', status: 'running', config: { wp_url: 'https://wp.test', helper_api_key: 'synthetic-helper-key' },
    state: { helper_api_key: 'synthetic-helper-key' }, triggered_by: 'manual', created_by: 'dev-user',
  });
});

const context = (workflowId: string) => ({
  request: new Request('http://localhost/api', { method: 'POST' }), params: { siteId: SITE, workflowId },
  cookies: { get: () => undefined }, locals: {},
}) as never;

it('masks credentials and omits internal state when polling', async () => {
  const { GET } = await import('../../pages/api/sites/[siteId]/workflows/[workflowId]/index') as { GET: APIRoute };
  const res = await GET(context('wf_1_run')) as Response;
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.config.helper_api_key).toBe('********');
  expect(body).not.toHaveProperty('state');
  expect(JSON.stringify(body)).not.toContain('synthetic-helper-key');
});

it('approves only a run that is paused for review', async () => {
  const { POST } = await import('../../pages/api/sites/[siteId]/workflows/[workflowId]/approve') as { POST: APIRoute };
  expect(((await POST(context('wf_1_run'))) as Response).status).toBe(409);
  const { getStore } = await import('../../lib/datastore');
  await getStore().updateDoc(`${paths.workflows(ORG)}/wf_1_run`, { type: 'seo_audit', status: 'paused_for_review' });
  expect(((await POST(context('wf_1_run'))) as Response).status).toBe(200);
  expect(resumed).toEqual(['wf_1_run']);
});
