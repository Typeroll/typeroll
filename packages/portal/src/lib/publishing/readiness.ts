import { selectedBuildProvider } from '../builds/selection';
import { readBuildEngine } from '../builds/cloudflare';
import { readGithubEngine } from '../builds/github';
import { readEngineConfiguration, assertEngineConnections } from '../builds/state';
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

export async function publishingReadiness(orgId: string, siteId: string, versionId = 'main', options: { checkBuild?: boolean } = {}) {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  const required: PublishingRequirement[] = [];
  if (site.publishing_mode !== 'customer_git') return { ready: true, mode: 'managed' as const, required };
  const group = await siteHostingGroup(orgId, siteId);
  const [github, cloudflare, organization, domains, media, storage] = await Promise.all([
    getConnection(orgId, 'github'), getConnection(orgId, 'cloudflare', group.id), getOrganizationDomains(orgId), getSiteDomains(orgId, siteId),
    store.listDocs(paths.media(orgId, siteId), { limit: 1 }), getConnection(orgId, 'cloudflare'),
  ]);
  const require = (condition: unknown, code: string, message: string, settings_url = '/app/settings/publishing') => {
    if (!condition) required.push({ code, message, settings_url });
  };
  require(github.status === 'connected' && github.github, 'github_connection_required', 'Connect GitHub for your organization.');
  require(cloudflare.status === 'connected' && cloudflare.cloudflare, 'cloudflare_connection_required', 'Connect Cloudflare for this site’s Hosting Group.');
  require(versionId === 'main' && domains.desired.website_host || group.sites_domain,
    'publishing_domain_required', versionId === 'main' ? 'Set a site address base for the Hosting Group or a website host in site settings.' : 'Set a site address base for the Hosting Group to publish this version.');
  // Accepted publications validate their frozen engine in the runner. Only new
  // admissions depend on the currently selected engine and its latest capabilities.
  if (options.checkBuild !== false) {
    const provider = await selectedBuildProvider(orgId);
    const [engine, visible] = await Promise.all([
      readEngineConfiguration(orgId, provider),
      provider === 'github' ? readGithubEngine(orgId) : readBuildEngine(orgId),
    ]);
    const buildsUrl = '/app/settings/publishing#publishing-builds';
    if (!engine || engine.status !== 'ready' || !visible.enabled || visible.state !== 'ready') {
      require(false, 'build_setup_required', 'Finish build setup and verification in Publishing → Builds.', buildsUrl);
    } else if (!engine.static_verification || !engine.media_preparation) {
      require(false, 'build_engine_update_required', 'Update the build engine in Publishing → Builds before publishing.', buildsUrl);
    } else {
      try { await assertEngineConnections(orgId, engine); }
      catch (error) {
        if (!(error instanceof ConnectionError)) throw error;
        require(false, 'build_connection_changed', 'Publishing connections changed. Update and verify the build engine in Publishing → Builds.', buildsUrl);
      }
    }
  }
  if (media.length) {
    require(connectionSummary(storage).media_ready, 'media_storage_required', 'Complete R2 media storage setup for your organization.', '/app/settings/publishing#media-title');
    require(domains.desired.media_host || organization.media_host, 'media_domain_required', 'Set a site media host or a shared media host for the organization.');
  }
  return { ready: required.length === 0, mode: 'customer_git' as const, hosting_group_id: group.id, required };
}

export class PublishingNotReady extends ConnectionError {
  constructor(public required: PublishingRequirement[]) {
    super('Set up Publishing before deploying this site. ' + required.map(item => item.message).join(' '), 409, 'publishing_setup_required');
  }
}

export async function assertPublishingReady(orgId: string, siteId: string, versionId = 'main', options: { checkBuild?: boolean } = {}) {
  const state = await publishingReadiness(orgId, siteId, versionId, options);
  if (!state.ready) throw new PublishingNotReady(state.required);
  return state;
}
