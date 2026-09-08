import { randomUUID } from 'node:crypto';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError, connectionSummary, getConnection } from './connections';
import { getOrganizationDomains, publicationHostname, saveOrganizationDomains } from './domain-config';

export interface HostingGroup {
  id: string;
  name: string;
  revision: string;
  sites_domain: string | null;
  dns_mode: 'automatic' | 'external';
}

export function hostingGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new ConnectionError('Select a valid Hosting Group.', 400);
  return value;
}

const groupPath = (orgId: string, id: string) => {
  if (!orgId || /[/\\\x00-\x1f]/.test(orgId) || orgId === '.' || orgId === '..') throw new ConnectionError('Invalid organization identity');
  return `${paths.org(orgId)}/hosting_groups/${hostingGroupId(id)}`;
};

/** Default aliases the original records, including the single rotating OAuth grant. */
export async function getHostingGroup(orgId: string, id = 'default'): Promise<HostingGroup> {
  const path = groupPath(orgId, id);
  if (id === 'default') {
    await getStore().createDocIfMissing(path, { name: 'Default', revision: randomUUID(), sites_domain: null, dns_mode: 'automatic' });
    const domains = await getOrganizationDomains(orgId);
    return { id, name: 'Default', revision: domains.revision, sites_domain: domains.sites_domain, dns_mode: domains.dns_mode };
  }
  const group = await getStore().getDoc<HostingGroup>(path);
  if (!group) throw new ConnectionError('Hosting Group not found in this organization.', 404, 'hosting_group_not_found');
  return { ...group, id };
}

export async function listHostingGroups(orgId: string) {
  await getHostingGroup(orgId);
  const groups = await getStore().listDocs<HostingGroup>(`${paths.org(orgId)}/hosting_groups`);
  return Promise.all(groups.sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.name.localeCompare(b.name)).map(async item => ({
    ...await getHostingGroup(orgId, item.id), connection: connectionSummary(await getConnection(orgId, 'cloudflare', item.id)),
  })));
}

export async function saveHostingGroup(orgId: string, input: Record<string, unknown>) {
  const id = input.id == null ? `group-${randomUUID()}` : hostingGroupId(input.id);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw new ConnectionError('Enter a Hosting Group name of 1–80 characters.', 400);
  const sites_domain = input.sites_domain ? publicationHostname(input.sites_domain) : null;
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS.', 400);
  if (id === 'default') {
    await saveOrganizationDomains(orgId, { revision: input.revision, sites_domain, dns_mode: input.dns_mode }, { queueMigration: false });
    return getHostingGroup(orgId);
  }
  const path = groupPath(orgId, id);
  const data = { name, sites_domain, dns_mode: input.dns_mode, revision: randomUUID() };
  if (input.id == null) await getStore().createDocIfMissing(path, data);
  else if (!await getStore().compareAndUpdateDoc<HostingGroup>(path, current => current.revision === input.revision, data)) {
    throw new ConnectionError('Hosting Group settings changed. Reload before saving.', 409, 'hosting_group_revision_conflict');
  }
  return getHostingGroup(orgId, id);
}

export async function siteHostingGroup(orgId: string, siteId: string) {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  return getHostingGroup(orgId, site.hosting_group_id ?? 'default');
}

/** Serialize assignment against the first real publication at the site document. */
export async function lockSiteHostingGroup(orgId: string, siteId: string) {
  const group = await siteHostingGroup(orgId, siteId);
  if (!await getStore().compareAndUpdateDoc<Site>(paths.site(orgId, siteId), site => (site.hosting_group_id ?? 'default') === group.id,
    { hosting_assignment_locked: true })) throw new ConnectionError('The site Hosting Group changed. Retry publishing.', 409, 'hosting_group_revision_conflict');
  return group;
}

/** Existing published sites need a migration; selecting a group never moves traffic. */
export async function assignHostingGroup(orgId: string, siteId: string, input: Record<string, unknown>) {
  const group = await getHostingGroup(orgId, hostingGroupId(input.hosting_group_id));
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  const previous = site.hosting_group_id ?? 'default';
  if (previous === group.id) return group;
  if (site.hosting_assignment_locked) throw new ConnectionError('Publishing has started for this site. Moving it to another Hosting Group requires a verified hosting migration.', 409, 'hosting_migration_required');
  if (input.previous_group_id !== previous) throw new ConnectionError('The site Hosting Group changed. Reload before saving.', 409);
  const jobs = await store.listDocs<any>(paths.deploys(orgId, siteId));
  if (jobs.some(job => ['queued', 'running', 'pending'].includes(job.status) || job.git_publication?.commit) || site.domain_status === 'live') {
    throw new ConnectionError('This site already has a publication or a build in progress. Moving it to another Hosting Group requires a verified hosting migration.', 409, 'hosting_migration_required');
  }
  if (!await store.compareAndUpdateDoc<Site>(paths.site(orgId, siteId), current => !current.hosting_assignment_locked && (current.hosting_group_id ?? 'default') === previous,
    { hosting_group_id: group.id })) throw new ConnectionError('The site changed. Reload before saving.', 409);
  return group;
}
