import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { discoverPublicWordPress } from '../../lib/wp/public-inventory';
import { redirectChainWarnings } from '../../lib/redirect-write';
import { unsavedPublicationTargets } from '../../lib/deploy/unsaved';
import { publicationBuildProgress } from '../../lib/builds/public-progress';
import { fetchGscMetrics } from '../../lib/wp/gsc-import';
import { checkInternalLinks } from '../../lib/internal-link-check';
import type { DeployJob } from '@typeroll/shared';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

describe('migration feedback safeguards', () => {
  it('discovers custom public types and bounded links without comments or other origins', async () => {
    const read = vi.fn(async (url: string) => {
      if (url.endsWith('/types')) return JSON.stringify({ event: { rest_base:'events' }, media:{rest_base:'media'} });
      if (url.includes('/events?')) return JSON.stringify([{link:'https://source.example/events/one'}]);
      if (url.includes('/pages?') || url.includes('/posts?')) return '[]';
      return '<script>var fake="<a href=/script-only>";</script><!-- <a href="/hidden">x</a> --><a href="/linked?q=1&amp;x=2">yes</a><a href="https://other.example/">no</a>';
    });
    const result = await discoverPublicWordPress('https://source.example', { read, crawlPages:1 });
    expect(result.urls).toEqual(['https://source.example/events/one', 'https://source.example/', 'https://source.example/linked?q=1&x=2']);
    expect(result.requests).toBe(5);
    expect(result.truncated).toBe(false);
    expect(read.mock.calls.some(([url]) => url.includes('/media?'))).toBe(false);
  });
  it('reports incomplete discovery instead of claiming full historical coverage', async () => {
    const result = await discoverPublicWordPress('https://source.example', { read:async () => '{}', maxRequests:1 });
    expect(result.truncated).toBe(true);
    expect(result.requests).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.coverage).toContain('Not proof');
  });
  it('reports chains, loops and a pattern reached from a literal without changing rules', () => {
    const rules = [
      { id:'a', from_path:'/a', to_path:'/b', status_code:301 as const },
      { id:'b', from_path:'/b', to_path:'/c', status_code:301 as const },
    ];
    expect(redirectChainWarnings(rules)).toEqual([{ code:'redirect_chain', from_path:'/a', via:['/a','/b'], final_target:'/c' }]);
    expect(redirectChainWarnings([...rules, {id:'c',from_path:'/c',to_path:'/a',status_code:301}]).every(w => w.code === 'redirect_loop')).toBe(true);
    expect(redirectChainWarnings([{...rules[0],to_path:'/old/item'}, {id:'p',from_path:'/old/*',to_path:'/new/:splat',status_code:301}])[0]?.final_target).toBe('/new/item');
    expect(rules[0].to_path).toBe('/b');
  });
  it('returns only unsaved target metadata from the selected version', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.workingCopy('org','site','page:a',MAIN_VERSION_ID), {kind:'page',target_id:'a',fields:{title:'private draft'},updated_at:'now',editor_id:'private-user'});
    await store.setDoc(paths.workingCopy('org','site','page:b','another'), {kind:'page',target_id:'b',fields:{title:'other branch'}});
    expect(await unsavedPublicationTargets('org','site',MAIN_VERSION_ID)).toEqual([{kind:'page',id:'a',updated_at:'now'}]);
  });
  it('binds progress to the exact site, job and version and excludes runner credentials', async () => {
    const { getStore } = await import('../../lib/datastore');
    const key = 'a'.repeat(64);
    const job = {id:'job',version_id:MAIN_VERSION_ID,git_publication:{build_task_key:key}} as unknown as DeployJob;
    await getStore().setDoc(`organizations/org/build_tasks/${key}`, {identity:{org_id:'org',site_id:'site',version_id:MAIN_VERSION_ID,job_id:'job'},status:'running',attempt:2,media_cursor:4,media_total:9,token_hash:'secret',lease_id:'secret'});
    expect(await publicationBuildProgress('org','site',job)).toEqual({status:'running',attempt:2,step:'preparing_media',completed:4,total:9,queued_since:null,retry_behavior:'A new publication does not automatically cancel this job. Retry only after a terminal failure; a queued timeout revokes the old task before a retry can run.'});
    expect(await publicationBuildProgress('org','other',job)).toBeNull();
    expect(await publicationBuildProgress('org','site',{...job,id:'different'})).toBeNull();
  });
  it('names the denied GSC property and service identity without silently changing properties', async () => {
    const request = vi.fn().mockRejectedValue({response:{status:403},secret:'must not leak'});
    const auth = {getClient:async () => ({request}),getCredentials:async () => ({client_email:'reader@example.test'})};
    await expect(fetchGscMetrics({property:'sc-domain:source.example', auth:auth as never})).rejects.toThrow('Grant read access to reader@example.test on this exact property');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('distinguishes unpublished targets and ignores navigation style metadata', async () => {
    const { getStore } = await import('../../lib/datastore'); const store = getStore();
    await store.setDoc(paths.page('org','site','home',MAIN_VERSION_ID), {title:'Home',slug:'home',status:'published',content_mode:'blocks',blocks:[{id:'nav',type:'template/navigation_links',data:{items:[{url:'/draft',label:'Draft'}]},part_styles:{current_link:'/not-a-page'}}]});
    await store.setDoc(paths.page('org','site','draft',MAIN_VERSION_ID), {title:'Draft',slug:'draft',status:'draft'});
    const report = await checkInternalLinks({store,orgId:'org',siteId:'site',versionId:MAIN_VERSION_ID,site:{id:'site',name:'Test',domain:'site.example'} as never});
    expect(report.broken).toEqual([]);
    expect(report.unpublished_targets).toEqual([{from:'page:home',href:'/draft',resolved_path:'/draft',page_id:'draft'}]);
  });
});
