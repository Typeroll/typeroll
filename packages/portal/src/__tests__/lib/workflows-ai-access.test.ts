// AI workflows on a Site without the Organization's AI key fail with the
// ai_not_enabled error instead of completing with nothing done. Agents rely
// on that to switch to doing the work themselves (MCP start_workflow docs).

import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'testorg';
const SITE = 'mysite';

describe('schema_markup without AI access', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('fails the step with ai_not_enabled rather than skipping every page', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, {
      title: 'About', slug: 'about', content_mode: 'html', status: 'published', html_content: '<h1>About</h1>',
    });
    const { schemaMarkupWorkflow } = await import('../../lib/workflows/schema-markup');
    const logs: string[] = [];
    const run = schemaMarkupWorkflow.steps[0]!.run({
      orgId: ORG, siteId: SITE, workflowId: 'wf', config: {}, state: {}, store,
      log: (msg: string) => logs.push(msg), setProgress: () => {},
    } as Parameters<typeof schemaMarkupWorkflow.steps[0]['run']>[0]);
    await expect(run).rejects.toMatchObject({ code: 'ai_not_enabled' });
    expect(logs.some((line) => line.startsWith('Skipped'))).toBe(false);
    const page = await store.getDoc<{ json_ld?: string }>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`);
    expect(page?.json_ld).toBeUndefined();
  });

  it('records failure_code ai_not_enabled on the run, as the API and MCP return it', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, {
      title: 'About', slug: 'about', content_mode: 'html', status: 'published', html_content: '<h1>About</h1>',
    });
    const { WorkflowEngine } = await import('../../lib/workflows/engine');
    const { schemaMarkupWorkflow } = await import('../../lib/workflows/schema-markup');
    const { workflowSummary } = await import('../../lib/workflows/service');
    const engine = new WorkflowEngine(store);
    const id = await engine.create({ orgId: ORG, siteId: SITE, def: schemaMarkupWorkflow, triggeredBy: 'manual', createdBy: 'test' });
    const run = await engine.start(ORG, id, schemaMarkupWorkflow);
    const summary = workflowSummary({ ...run, id });
    expect(summary.status).toBe('failed');
    expect(summary.failure_code).toBe('ai_not_enabled');
    expect(summary.failure_reason).toMatch(/AI assistant is not enabled for this site/);
  });
});
