import { describe, it, expect } from 'vitest';
import { domainPublicationIntent } from '../../lib/publishing/domain-publication-intent';
import type { DomainConfiguration } from '../../lib/publishing/domain-config';
const hosts = {website_host:'old.example.com',media_host:null,media_path_prefix:''};
const config: DomainConfiguration = {revision:'new-revision',active:hosts,desired:{...hosts,website_host:'new.example.com'},dns_mode:'automatic',state:'declared',media_aliases:[]};
describe('publication domain intent', () => {
  it('names both hosts and requires acknowledgement of the exact revision', () => {
    expect(domainPublicationIntent(config)).toMatchObject({code:'domain_candidate_confirmation_required',revision:'new-revision',current_host:'old.example.com',future_host:'new.example.com',updates_current_host:false});
  });
  it('does not interrupt ordinary or first publications', () => {
    expect(domainPublicationIntent({...config,active:null})).toBeNull();
    expect(domainPublicationIntent({...config,desired:hosts})).toBeNull();
  });
  it('also explains media-only and redirect-only preparations', () => {
    expect(domainPublicationIntent({...config,desired:{...hosts,media_host:'media.example.com'}})).not.toBeNull();
    expect(domainPublicationIntent({...config,desired:{...hosts,redirect_hosts:['www.example.com']}})).not.toBeNull();
  });
});

it('blocks API queueing until the current candidate revision is explicitly confirmed', async () => {
  const { makeTmpFixtures, resetDatastore } = await import('../helpers/tmp-fixtures');
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  const { createApiKey } = await import('../../lib/api-keys');
  const { siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const queue = await import('../../lib/deploy/queue');
  const { vi } = await import('vitest');
  makeTmpFixtures(); await resetDatastore();
  const store=getStore(), org='org', site='site';
  await store.setDoc(paths.site(org,site),{name:'Synthetic',publishing_mode:'customer_git'});
  await store.setDoc(paths.version(org,site,'main'),{kind:'main'});
  await store.setDoc(siteDomainConfigPath(org,site),config);
  const {token}=await createApiKey({orgId:org,siteId:site,name:'test',createdBy:'test@example.com'});
  const enqueue=vi.fn(); const spy=vi.spyOn(queue,'getDeployQueue').mockReturnValue({enqueue} as never);
  try {
    const {POST}=await import('../../pages/api/v1/sites/[siteId]/deploy');
    const call=(body:object)=>POST({params:{siteId:site},request:new Request('https://cms.example.com/api/v1/sites/site/deploy',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({dry_run:true,...body})})} as never);
    for(const body of [{},{domain_candidate_revision:'stale'}]) {
      const response=await call(body);expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({revision:'new-revision',updates_current_host:false});
      expect(enqueue).not.toHaveBeenCalled();
    }
    const response=await call({domain_candidate_revision:'new-revision'});expect(response.status).toBe(202);
    const result=await response.json();
    expect(await store.getDoc(paths.deploy(org,site,result.job_id))).toMatchObject({domain_candidate_revision:'new-revision'});
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally {spy.mockRestore();}
});
