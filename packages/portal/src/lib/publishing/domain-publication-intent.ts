import { samePublicationHosts, sameRedirectHosts, type DomainConfiguration } from './domain-config';

/** Saving future hosts never changes an ordinary publication's destination. */
export function domainPublicationIntent(config: DomainConfiguration) {
  if (config.active && samePublicationHosts(config.active, config.desired) && sameRedirectHosts(config.active, config.desired)) return null;
  if (!config.desired.website_host && !config.desired.media_host && !config.desired.redirect_hosts?.length) return null;
  return {
    revision: config.revision,
    current_host: config.active?.website_host ?? null,
    future_host: config.desired.website_host,
    updates_current_host: true,
    requires_confirmation: false,
    message: 'Normal publication continues at the current website or temporary address. These future addresses are only used when you choose Prepare for domain switch, shortly before changing DNS. Publishing newer content makes an older domain candidate outdated.',
  };
}
