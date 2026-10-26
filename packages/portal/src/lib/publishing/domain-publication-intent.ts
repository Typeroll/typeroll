import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getSiteDomains, samePublicationHosts, sameRedirectHosts, type DomainConfiguration } from './domain-config';

/** Explain a future-host build before queueing it; never imply that it updates the active host. */
export function domainPublicationIntent(config: DomainConfiguration) {
  if (!config.active || (samePublicationHosts(config.active, config.desired) && sameRedirectHosts(config.active, config.desired))) return null;
  return {
    code: 'domain_candidate_confirmation_required',
    revision: config.revision,
    current_host: config.active.website_host,
    future_host: config.desired.website_host,
    updates_current_host: false,
    requires_confirmation: true,
    error: 'Future domain settings are saved. This build prepares a domain-switch candidate and waits for separate traffic approval; it does not update the current website or test address. Confirm this domain revision to prepare saved content, or use a signed preview to review edits. To move only already-published content, use Prepare domain change from published content.',
  };
}

export async function readDomainPublicationIntent(orgId: string, siteId: string, versionId: string) {
  if (versionId !== 'main') return null;
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  return site?.publishing_mode === 'customer_git' ? domainPublicationIntent(await getSiteDomains(orgId, siteId)) : null;
}
