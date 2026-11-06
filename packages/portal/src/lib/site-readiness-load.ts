// Wires the readiness report to live storage and the organization's
// Cloudflare connection. Kept apart from site-readiness.ts so the report
// itself stays testable without provider clients.

import { usesCustomerPublishing, type Site } from '@typeroll/shared';
import type { ReadWriteStore } from './datastore';
import { readSiteReadiness, type SiteReadinessReport } from './site-readiness';
import { getSiteDomains } from './publishing/domain-config';
import { siteZoneSources } from './publishing/host-checks';
import { readZoneAiPolicy } from './publishing/zone-ai-policy';
import { publicUrlsFor } from './site-public-urls';

export async function siteReadinessReport(store: ReadWriteStore, orgId: string, site: Site & { id: string }, versionId: string): Promise<SiteReadinessReport> {
  return readSiteReadiness({
    store, orgId, siteId: site.id, versionId, site,
    readZone: async () => {
      const domains = usesCustomerPublishing(site) ? await getSiteDomains(orgId, site.id) : null;
      const production = publicUrlsFor(site).production;
      const host = domains ? (domains.active?.website_host ?? domains.desired.website_host) : production ? new URL(production).hostname : null;
      return readZoneAiPolicy(host, await siteZoneSources(orgId, site.id));
    },
  });
}
