import { readOrganizationAccess } from '../organization-access';
import { resolvePublicationVersion } from './publication-version';
import { selectedBuildProvider } from '../builds/selection';
import { readBuildEngine } from '../builds/cloudflare';
import { readGithubEngine } from '../builds/github';
import { readEngineConfiguration, assertEngineConnections } from '../builds/state';
import { siteHostingGroup } from './hosting-groups';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, connectionSummary, ConnectionError } from './connections';
import { getOrganizationDomains, getSiteDomains, activePublicationDomains } from './domain-config';
import { assertSiteHostingAvailable, HOSTED_MODE, SITE_HOSTING_UNAVAILABLE, siteHostingAvailable } from './site-hosting';

export type PublishingMode = 'customer_git' | typeof HOSTED_MODE;

/**
 * Every new site publishes through its organization's build engine and
 * hosting. Only an internal caller asks for a hosted site, which is refused
 * unless this deployment has a hosting service bound.
 */
export function newSitePublishingMode(requested?: typeof HOSTED_MODE): PublishingMode {
  if (requested !== HOSTED_MODE) return 'customer_git';
  assertSiteHostingAvailable();
  return HOSTED_MODE;
}

/**
 * Typeroll no longer builds sites on its own servers. A site still in the
 * former managed mode publishes again once it is migrated to customer
 * publishing (migrate_managed_site_publishing, or Site settings → Publishing).
 */
export const MANAGED_PUBLISHING_REMOVED = {
  code: 'managed_publishing_migration_required',
  message: 'This site still uses Typeroll-managed publishing, which is no longer available. Migrate it to your organization’s publishing in Site settings → Publishing (or with migrate_managed_site_publishing), then publish again. The live site is unchanged.',
} as const;

export interface PublishingRequirement { code: string; message: string; settings_url: string }

export async function publishingReadiness(orgId: string, siteId: string, versionId = 'main', options: { checkBuild?: boolean } = {}) {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  const required: PublishingRequirement[] = [];
  if (options.checkBuild !== false && !(await readOrganizationAccess(orgId)).can_write) {
    return { ready: false, mode: site.publishing_mode === 'customer_git' || site.publishing_mode === HOSTED_MODE ? site.publishing_mode : 'managed' as const,
      required: [{ code: 'organization_access_ended', message: 'Activate a subscription to continue publishing. Existing static sites remain online.', settings_url: '/app/settings/access' }] };
  }
  // Accepted jobs validate their frozen source; new admissions validate saved content.
  if (options.checkBuild !== false) {
    try { await resolvePublicationVersion(orgId, siteId, versionId); }
    catch (error) {
      required.push({ code: 'content_export_invalid', message: error instanceof Error ? error.message : 'Content cannot be exported.', settings_url: `/app/sites/${encodeURIComponent(siteId)}/pages` });
    }
  }
  if (site.publishing_mode === HOSTED_MODE) return hostedReadiness(orgId, siteId, versionId, options, required);
  if (site.publishing_mode !== 'customer_git') {
    required.push({ ...MANAGED_PUBLISHING_REMOVED, settings_url: `/app/sites/${encodeURIComponent(siteId)}/settings` });
    return { ready: false, mode: 'managed' as const, required };
  }
  const group = await siteHostingGroup(orgId, siteId);
  const [github, cloudflare, organization, savedDomains, media, storage] = await Promise.all([
    getConnection(orgId, 'github'), getConnection(orgId, 'cloudflare', group.id), getOrganizationDomains(orgId), getSiteDomains(orgId, siteId),
    store.listDocs(paths.media(orgId, siteId), { limit: 1 }), getConnection(orgId, 'cloudflare'),
  ]);
  const domains = activePublicationDomains(savedDomains, site?.publishing_migration?.website_host);
  const require = (condition: unknown, code: string, message: string, settings_url = '/app/settings/publishing') => {
    if (!condition) required.push({ code, message, settings_url });
  };
  require(github.status === 'connected' && github.github, 'github_connection_required', 'Connect GitHub for your organization.');
  require(cloudflare.status === 'connected' && cloudflare.cloudflare, 'cloudflare_connection_required', 'Connect Cloudflare for this site’s Hosting Group.');
  require(versionId === 'main' && domains.desired.website_host || group.sites_domain,
    'publishing_domain_required', versionId === 'main' ? 'Set a site address base for the Hosting Group before the first publication. Future website hosts are prepared separately.' : 'Set a site address base for the Hosting Group to publish this version.');
  // Accepted publications validate their frozen engine in the runner. Only new
  // admissions depend on the currently selected engine and its latest capabilities.
  if (options.checkBuild !== false) required.push(...await buildEngineRequirements(orgId));
  if (media.length) {
    require(connectionSummary(storage).media_ready, 'media_storage_required', 'Complete R2 media storage setup for your organization.', '/app/settings/publishing#media-title');
    require(domains.desired.media_host || organization.media_host, 'media_domain_required', 'Images are served from the organization’s shared media host. In Publishing, choose a domain in your connected Cloudflare account to set it up, for example media.example.com.');
  }
  return { ready: required.length === 0, mode: 'customer_git' as const, hosting_group_id: group.id, required };
}

/** What the organization's selected build engine still needs before a new publication is admitted. */
async function buildEngineRequirements(orgId: string): Promise<PublishingRequirement[]> {
  const provider = await selectedBuildProvider(orgId);
  const [engine, visible] = await Promise.all([
    readEngineConfiguration(orgId, provider),
    provider === 'github' ? readGithubEngine(orgId) : readBuildEngine(orgId),
  ]);
  const settings_url = '/app/settings/publishing#publishing-builds';
  if (!engine || engine.status !== 'ready' || !visible.enabled || visible.state !== 'ready') {
    return [{ code: 'build_setup_required', message: 'Finish build setup and verification in Publishing → Builds.', settings_url }];
  }
  if (!engine.static_verification || !engine.media_preparation || engine.publication_validation !== 1) {
    return [{ code: 'build_engine_update_required', message: 'Update the build engine in Publishing → Builds before publishing.', settings_url }];
  }
  try { await assertEngineConnections(orgId, engine); }
  catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    return [{ code: 'build_connection_changed', message: 'Publishing connections changed. Update and verify the build engine in Publishing → Builds.', settings_url }];
  }
  return [];
}

/**
 * A hosted site is built by the organization's build engine and served by
 * the bound hosting service: no GitHub repository, Hosting Group or website
 * domain to set up. Only the main version publishes (one live site). Refused
 * by name when no hosting service is bound.
 */
async function hostedReadiness(orgId: string, siteId: string, versionId: string, options: { checkBuild?: boolean }, required: PublishingRequirement[]) {
  const settings_url = `/app/sites/${encodeURIComponent(siteId)}/settings`;
  if (!siteHostingAvailable()) {
    return { ready: false, mode: HOSTED_MODE, required: [...required, { ...SITE_HOSTING_UNAVAILABLE, settings_url }] };
  }
  if (versionId !== 'main') required.push({ code: 'hosting_version_unsupported', message: 'This site publishes its main version only. Merge the version into main to publish it.', settings_url });
  if (options.checkBuild !== false) required.push(...await buildEngineRequirements(orgId));
  const [media, storage] = await Promise.all([getStore().listDocs(paths.media(orgId, siteId), { limit: 1 }), getConnection(orgId, 'cloudflare')]);
  if (media.length && !connectionSummary(storage).media_ready) {
    required.push({ code: 'media_storage_required', message: 'Complete R2 media storage setup for your organization.', settings_url: '/app/settings/publishing#media-title' });
  }
  return { ready: required.length === 0, mode: HOSTED_MODE, required };
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
