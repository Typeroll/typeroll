// SEO audit on block pages: headings, text and images come from the rendered
// blocks, not from html_content (which block pages leave empty).

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';
import type { WorkflowContext } from '../../lib/workflows/types';

const ORG = 'orgone';
const SITE = 'mysite';
const LONG = 'Vi bygger webbplatser som håller i många år. '.repeat(10);

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/om`, {
    title: 'Om oss', slug: 'om', status: 'published', content_mode: 'blocks',
    blocks: [
      { id: 'title', type: 'core/heading', data: { text: 'Om oss', level: 'h1' } },
      { id: 'body', type: 'core/prose', data: { html: `<p>${LONG}</p>` } },
      { id: 'img', type: 'core/image', data: { src: '/media/a.jpg', alt: '' } },
    ],
  });
  await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/tom`, {
    title: 'Tom', slug: 'tom', status: 'published', content_mode: 'blocks',
    blocks: [{ id: 'body', type: 'core/prose', data: { html: '<p>Kort</p>' } }],
  });
});

async function crawl(): Promise<Array<{ page_id: string; issues: string[] }>> {
  const { seoAuditWorkflow } = await import('../../lib/workflows/seo-audit');
  const { getStore } = await import('../../lib/datastore');
  const ctx = {
    orgId: ORG, siteId: SITE, workflowId: 'wf', config: {}, state: {}, store: getStore(),
    log: () => {}, setProgress: () => {},
  } as unknown as WorkflowContext;
  const out = await seoAuditWorkflow.steps[0].run(ctx);
  return (out as { state: { audits: Array<{ page_id: string; issues: string[] }> } }).state.audits;
}

describe('SEO audit on block pages', () => {
  it('counts headings and text rendered from blocks', async () => {
    const audits = await crawl();
    const om = audits.find((a) => a.page_id === 'om')!;
    expect(om.issues.some((i) => i.startsWith('Thin content'))).toBe(false);
    expect(om.issues).not.toContain('No H1 heading');
  });

  it('still reports thin block pages without an H1', async () => {
    const tom = (await crawl()).find((a) => a.page_id === 'tom')!;
    expect(tom.issues.some((i) => i.startsWith('Thin content'))).toBe(true);
    expect(tom.issues).toContain('No H1 heading');
  });
});
