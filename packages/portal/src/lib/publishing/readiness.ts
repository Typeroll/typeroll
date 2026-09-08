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
  const [github, cloudflare, organization, domains, media] = await Promise.all([
    getConnection(orgId, 'github'), getConnection(orgId, 'cloudflare'), getOrganizationDomains(orgId), getSiteDomains(orgId, siteId),
    store.listDocs(paths.media(orgId, siteId)),
  ]);
  const require = (condition: unknown, code: string, message: string, settings_url = '/app/settings/publishing') => {
    if (!condition) required.push({ code, message, settings_url });
  };
  require(github.status === 'connected' && github.github, 'github_connection_required', 'Connect GitHub for your organization.');
  require(cloudflare.status === 'connected' && cloudflare.cloudflare, 'cloudflare_connection_required', 'Connect Cloudflare for your organization.');
  require(versionId === 'main' && domains.desired.website_host || organization.default_domain,
    'publishing_domain_required', versionId === 'main' ? 'Set an organization default domain or a website host in site settings.' : 'Set an organization default domain to publish this version.');
  if (media.length) {
    require(connectionSummary(cloudflare).media_ready, 'media_storage_required', 'Complete R2 media storage setup for your organization.');
    require(domains.desired.media_host || organization.default_domain, 'media_domain_required', 'Set a media host or an organization default domain.');
  }
  return { ready: required.length === 0, mode: 'customer_git' as const, required };
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
