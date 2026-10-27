import { describe, it, expect } from 'vitest';
import { domainPublicationIntent } from '../../lib/publishing/domain-publication-intent';
import type { DomainConfiguration } from '../../lib/publishing/domain-config';
const hosts = {website_host:'old.example.com',media_host:null,media_path_prefix:''};
const config: DomainConfiguration = {revision:'new-revision',active:hosts,desired:{...hosts,website_host:'new.example.com'},dns_mode:'automatic',state:'declared',media_aliases:[]};
describe('publication domain intent', () => {
  it('explains that ordinary publication continues at the current host', () => {
    expect(domainPublicationIntent(config)).toMatchObject({revision:'new-revision',current_host:'old.example.com',future_host:'new.example.com',updates_current_host:true,requires_confirmation:false});
  });
  it('does not interrupt ordinary or first publications', () => {
    expect(domainPublicationIntent({...config,active:null})).toMatchObject({current_host:null,updates_current_host:true});
    expect(domainPublicationIntent({...config,desired:hosts})).toBeNull();
  });
  it('also explains media-only and redirect-only preparations', () => {
    expect(domainPublicationIntent({...config,desired:{...hosts,media_host:'media.example.com'}})).not.toBeNull();
    expect(domainPublicationIntent({...config,desired:{...hosts,redirect_hosts:['www.example.com']}})).not.toBeNull();
  });
});

it('accepts ordinary API publication without confirming declared future domains', async () => {
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
    const response=await call({});expect(response.status).toBe(202);
    const result=await response.json();
    expect(await store.getDoc(paths.deploy(org,site,result.job_id))).not.toHaveProperty('publication_intent');
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally {spy.mockRestore();}
});

it('keeps deployed origins independently from subsequently saved future hosts', async () => {
  const { activePublicationDomains, hasPendingPublishedDomains } = await import('../../lib/publishing/domain-config');
  const published = { hosts: config.desired, dns_mode: 'external' as const, publication_id: 'main-publication' };
  const later = { ...config, published, desired: { ...hosts, website_host: 'later.example.com' } };
  expect(activePublicationDomains(later)).toMatchObject({ desired: published.hosts, dns_mode: 'external' });
  expect(hasPendingPublishedDomains(later)).toBe(true);
  expect(domainPublicationIntent(later)).toMatchObject({ current_host: 'old.example.com', published_host: 'new.example.com', future_host: 'later.example.com' });
  expect(hasPendingPublishedDomains({ ...later, active: published.hosts })).toBe(false);
  expect(domainPublicationIntent({...later,desired:hosts})).toMatchObject({published_host:'new.example.com',future_host:'old.example.com'});
});
