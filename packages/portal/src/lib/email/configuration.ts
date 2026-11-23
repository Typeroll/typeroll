// Resolve the owning Site's selected account afresh for every send. A shared
// Organization account is a reference plus an explicit owner grant, not a copy.
import { createHash } from 'node:crypto';
import { paths, type EmailConnector, type OrganizationEmailSettings, type SiteIntegrations } from '@typeroll/shared';
import { getStore } from '../datastore';

export const organizationEmailPath = (orgId: string) => `organizations/${orgId}/settings/email`;
export const DEFAULT_BULK_EMAIL_POLICY = { daily_limit: 10, minimum_interval_minutes: 15 } as const;
export const emailSettingsRevision = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export function bulkEmailPolicy(input: SiteIntegrations['bulk_email']) {
  return { daily_limit: Number.isSafeInteger(input?.daily_limit) && input!.daily_limit >= 0 && input!.daily_limit <= 10000 ? input!.daily_limit : DEFAULT_BULK_EMAIL_POLICY.daily_limit,
    minimum_interval_minutes: Number.isSafeInteger(input?.minimum_interval_minutes) && input!.minimum_interval_minutes >= 1 && input!.minimum_interval_minutes <= 1440 ? input!.minimum_interval_minutes : DEFAULT_BULK_EMAIL_POLICY.minimum_interval_minutes };
}
export async function readSiteEmailConfiguration(orgId: string, siteId: string) {
  const store = getStore();
  const doc = await store.getDoc<SiteIntegrations>(paths.integrations(orgId, siteId));
  const source = doc?.email_source ?? 'site';
  const organization = await store.getDoc<OrganizationEmailSettings>(organizationEmailPath(orgId));
  const allowed = !!organization?.email && Array.isArray(organization.allowed_site_ids) && organization.allowed_site_ids.includes(siteId);
  const connector: EmailConnector | null = source === 'organization' ? allowed ? organization!.email! : null : source === 'site' ? doc?.email ?? null : null;
  return { source, connector, policy: bulkEmailPolicy(doc?.bulk_email), organization_available: allowed,
    organization_from: allowed ? organization!.email!.from : null, document: doc, organization };
}
export async function resolveSiteEmailConnector(orgId: string, siteId: string): Promise<EmailConnector | null> {
  return (await readSiteEmailConfiguration(orgId, siteId)).connector;
}
export async function siteEmailQueuePolicy(orgId: string, siteId: string) {
  const configuration = await readSiteEmailConfiguration(orgId, siteId);
  return { ...configuration.policy, source: configuration.source, ready: !!configuration.connector,
    from: configuration.connector?.from ?? null, reply_to: configuration.connector?.reply_to ?? null };
}
