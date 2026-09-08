import { siteHostingGroup } from './hosting-groups';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, connectionSummary, ConnectionError } from './connections';
import { getOrganizationDomains, getSiteDomains } from './domain-config';

export function newSitePublishingMode(): 'customer_git' | 'managed' {
  const mode = process.env.NEW_SITE_PUBLISHING_MODE ?? 'managed';
  if (mode !== 'customer_git' && mode !== 'managed') throw new Error('Invalid NEW_SITE_PUBLISHING_MODE');
  return mode;
}

export interface PublishingRequirement { code: string; message: string; settings_url: string }

export async function publishingReadiness(orgId: string, siteId: string, versionId = 'main') {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  const required: PublishingRequirement[] = [];
  if (site.publishing_mode !== 'customer_git') return { ready: true, mode: 'managed' as const, required };
  const group = await siteHostingGroup(orgId, siteId);
  const [github, cloudflare, organization, domains, media, storage] = await Promise.all([
    getConnection(orgId, 'github'), getConnection(orgId, 'cloudflare', group.id), getOrganizationDomains(orgId), getSiteDomains(orgId, siteId),
    store.listDocs(paths.media(orgId, siteId)), getConnection(orgId, 'cloudflare'),
  ]);
  const require = (condition: unknown, code: string, message: string, settings_url = '/app/settings/publishing') => {
    if (!condition) required.push({ code, message, settings_url });
  };
  require(github.status === 'connected' && github.github, 'github_connection_required', 'Connect GitHub for your organization.');
  require(cloudflare.status === 'connected' && cloudflare.cloudflare, 'cloudflare_connection_required', 'Connect Cloudflare for this site’s Hosting Group.');
  require(versionId === 'main' && domains.desired.website_host || group.sites_domain,
    'publishing_domain_required', versionId === 'main' ? 'Set a site address base for the Hosting Group or a website host in site settings.' : 'Set a site address base for the Hosting Group to publish this version.');
  if (media.length) {
    require(connectionSummary(storage).media_ready, 'media_storage_required', 'Complete R2 media storage setup for your organization.');
    require(domains.desired.media_host || organization.media_host, 'media_domain_required', 'Set a site media host or a shared media host for the organization.');
  }
  return { ready: required.length === 0, mode: 'customer_git' as const, hosting_group_id: group.id, required };
}

export class PublishingNotReady extends ConnectionError {
  constructor(public required: PublishingRequirement[]) {
    super('Set up Publishing before deploying this site. ' + required.map(item => item.message).join(' '), 409, 'publishing_setup_required');
  }
}

export async function assertPublishingReady(orgId: string, siteId: string, versionId = 'main') {
  const state = await publishingReadiness(orgId, siteId, versionId);
  if (!state.ready) throw new PublishingNotReady(state.required);
  return state;
}
