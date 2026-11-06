import type { Site } from './types.js';

export type SitePublishingMode = 'customer_git' | 'hosted';

/**
 * How a site publishes. Every site publishes through its organization's own
 * GitHub and hosting accounts (`customer_git`) unless it is `hosted`; a
 * missing or older stored value means customer publishing.
 */
export function sitePublishingMode(site: Pick<Site, 'publishing_mode'> | null | undefined): SitePublishingMode {
  return site?.publishing_mode === 'hosted' ? 'hosted' : 'customer_git';
}

/** True for a site that publishes through its organization's own accounts. */
export function usesCustomerPublishing(site: Pick<Site, 'publishing_mode'> | null | undefined): boolean {
  return sitePublishingMode(site) === 'customer_git';
}
