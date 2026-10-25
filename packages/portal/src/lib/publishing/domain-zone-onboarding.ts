import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { siteHostingGroup } from './hosting-groups';
import { publicationHostname, getSiteDomains } from './domain-config';
import { findZone } from './domain-provider';
import { dnsRecordBody } from './domain-cutover-journal';
import { mapPublicationParts } from './parallel';

const planPath = (org: string, site: string) => `${paths.org(org)}/publishing_dns_plans/${site}`;
const supported = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS']);
const identity = (record: any) => JSON.stringify([record.type, record.name.toLowerCase().replace(/\.$/, ''), record.content, record.priority ?? null, record.data ?? null]);

/** Organization-admin only: zone-wide resources never inherit site-editor authority. */
export async function onboardDomainZone(org: string, site: string, input: Record<string, unknown>) {
  if (!await getStore().getDoc(paths.site(org, site))) throw new ConnectionError('Select a site owned by this organization.', 404);
  const config = await getSiteDomains(org, site), group = await siteHostingGroup(org, site);
  const name = publicationHostname(input.zone_name);
  if (!config.desired.website_host || !(config.desired.website_host === name || config.desired.website_host.endsWith(`.${name}`))) throw new ConnectionError('The zone must contain this site’s saved website host.', 400, 'zone_host_mismatch');
  const connection = await getConnection(org, 'cloudflare', group.id);
  if (!connection.cloudflare || connection.status !== 'connected') throw new ConnectionError('Connect the Hosting Group’s Cloudflare account first.', 409);
  const account = connection.cloudflare.account_id, provider = await cloudflareClient(org, fetch, undefined, group.id);
  let zone = await findZone(provider, account, name);
  if (input.action === 'create_zone') {
    if (zone && zone.name !== name) throw new ConnectionError('This hostname is already covered by an existing zone. Use that zone instead.', 409);
    if (!zone) {
      await provider('/zones', { method: 'POST', body: { account: { id: account }, name, type: 'full' } });
      zone = await findZone(provider, account, name);
    }
    return { zone, account_id: account, next_action: 'scan_dns', message: 'Zone created or already present. Keep the current nameservers until the DNS inventory is reviewed and copied. Typeroll never changes your registrar.' };
  }
  if (!zone || zone.name !== name) throw new ConnectionError('Create the domain zone in this Hosting Group’s account first.', 409, 'domain_zone_required');
  if (zone.status !== 'pending') throw new ConnectionError('DNS onboarding is only for a pending zone. An active zone must be managed through the normal reviewed domain flow.', 409, 'zone_already_active');
  if (input.action === 'scan_dns') {
    await provider(`/zones/${zone.id}/dns_records/scan/trigger`, { method: 'POST' });
    return { zone, next_action: 'review_dns', message: 'Scan started. Review the discovered records when ready. Scans can omit mail, DKIM and uncommon records; compare with your existing provider’s full inventory.' };
  }
  const listCurrent = async () => {
    const records = await provider(`/zones/${zone!.id}/dns_records?per_page=5000`);
    if (!Array.isArray(records) || records.length >= 5000) throw new ConnectionError('The DNS inventory is too large for guided onboarding. Import it with your DNS administrator.', 409);
    return records;
  };
  if (input.action === 'review_dns') {
    const scanned = await provider(`/zones/${zone.id}/dns_records/scan/review`);
    if (!Array.isArray(scanned) || scanned.length > 500) throw new ConnectionError('The scan is unavailable or exceeds 500 records. Review the inventory with your DNS administrator.', 409);
    const current = await listCurrent();
    const records: Array<Record<string, any>> = scanned.map((record: any) => {
      if (!supported.has(record.type) || typeof record.name !== 'string' || !(record.name === name || record.name.endsWith(`.${name}`))) throw new ConnectionError('The scan contains an unsupported record. Review it with your DNS administrator.', 409, 'unsupported_dns_record');
      return { ...dnsRecordBody(record), proxied: false };
    });
    const comparisons = await mapPublicationParts<any, any>(records, async record => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      try { return { record, current_public_answers: await resolver.resolve(record.name, record.type), lookup: 'answered' }; }
      catch (error) { return { record, current_public_answers: [], lookup: (error as any)?.code === 'ENODATA' || (error as any)?.code === 'ENOTFOUND' ? 'not_found' : 'unavailable' }; }
    }, 4);
    const additions = records.filter(record => !current.some((item: any) => identity(item) === identity(record)));
    const conflicts = records.filter(record => current.some((item: any) => identity(item) === identity(record) ? item.proxied === true : item.name === record.name && (item.type === record.type || item.type === 'CNAME' || record.type === 'CNAME')));
    const plan = { revision: randomUUID(), zone_id: zone.id, zone_name: name, account_id: account, connection_revision: connection.revision, expires_at: Date.now() + 3600000,
      records: additions, existing: current.map(dnsRecordBody), conflicts, comparisons, state: 'review' };
    await getStore().setDoc(planPath(org, site), plan);
    return { ...plan, zone, warning: 'A scan is not a complete DNS backup. Confirm web, MX, SPF, every DKIM selector, DMARC and verification records against the existing provider before applying or changing nameservers. All added records are DNS only.' };
  }
  if (input.action === 'apply_dns') {
    const path = planPath(org, site), plan = await getStore().getDoc<any>(path);
    if (!plan || plan.revision !== input.plan_revision || plan.zone_id !== zone.id || plan.account_id !== account || plan.connection_revision !== connection.revision || plan.expires_at < Date.now()) throw new ConnectionError('Review a fresh DNS plan before applying it.', 409, 'dns_plan_stale');
    if (input.confirm_inventory !== true || plan.conflicts.length || !plan.records.length && !plan.existing.length) throw new ConnectionError('Confirm the complete DNS inventory and resolve conflicting records before applying.', 409, 'dns_inventory_review_required');
    const lease = randomUUID();
    if (!await getStore().compareAndUpdateDoc<any>(path, value => value.revision === plan.revision && (!value.lease_until || value.lease_until < Date.now()), { lease, lease_until: Date.now() + 300000 })) throw new ConnectionError('This DNS plan is already being applied. Refresh its status.', 409, 'dns_plan_busy');
    try {
      for (const record of plan.records) {
        if (!await getStore().compareAndUpdateDoc<any>(path, value => value.lease === lease && value.lease_until > Date.now(), { lease_until: Date.now() + 300000 })) throw new ConnectionError('DNS plan ownership changed. Refresh before continuing.', 409, 'dns_plan_busy');
        const current = await listCurrent();
        if (current.some((item: any) => identity(item) === identity(record) && item.proxied === true)) throw new ConnectionError('An existing record is proxied. Review a new plan; onboarding never changes existing records.', 409, 'dns_revision_conflict');
        if (current.some((item: any) => identity(item) === identity(record) && item.proxied !== true)) continue;
        if (current.some((item: any) => item.name === record.name && (item.type === 'CNAME' || record.type === 'CNAME' || item.type === record.type && !plan.records.some((planned: any) => identity(planned) === identity(item))))) throw new ConnectionError('DNS changed since review. Existing records were not replaced. Review a new plan.', 409, 'dns_revision_conflict');
        await provider(`/zones/${zone.id}/dns_records`, { method: 'POST', body: { ...record, proxied: false } });
      }
      await getStore().updateDoc(path, { state: 'applied' });
      return { state: 'applied', zone, next_action: 'change_nameservers', message: `DNS-only records copied. At your domain registrar, replace the nameservers with ${(zone.name_servers ?? []).join(', ')}. Then return here and refresh checks. Typeroll has not changed your registrar or enabled proxying.` };
    } finally { await getStore().compareAndUpdateDoc<any>(path, value => value.lease === lease, { lease: null, lease_until: 0 }); }
  }
  throw new ConnectionError('Choose create_zone, scan_dns, review_dns or apply_dns.', 400);
}
