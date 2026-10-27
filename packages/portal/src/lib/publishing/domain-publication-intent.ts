import { samePublicationHosts, sameRedirectHosts, type DomainConfiguration } from './domain-config';

/** Saving future hosts never changes an ordinary publication's destination. */
export function domainPublicationIntent(config: DomainConfiguration) {
  if (config.active && samePublicationHosts(config.active, config.desired) && sameRedirectHosts(config.active, config.desired) &&
      (!config.published || samePublicationHosts(config.published.hosts, config.active) && sameRedirectHosts(config.published.hosts, config.active))) return null;
  if (!config.desired.website_host && !config.desired.media_host && !config.desired.redirect_hosts?.length) return null;
  return {
    revision: config.revision,
    current_host: config.active?.website_host ?? null,
    published_host: config.published?.hosts.website_host ?? config.active?.website_host ?? null,
    future_host: config.desired.website_host,
    updates_current_host: true,
    requires_confirmation: false,
    message: config.published && !samePublicationHosts(config.published.hosts, config.active ?? {website_host:null,media_host:null,media_path_prefix:''})
      ? 'The main site already uses the published domain addresses. Normal publication keeps those addresses and updates the same site while DNS is pending. Saving different future addresses does not apply them. Review and switch DNS separately.'
      : 'Normal publication continues at the current website or temporary address. Choose Publish for the new domain shortly before changing DNS: it replaces the same main site with the new addresses. DNS is switched separately afterward.',
  };
}
