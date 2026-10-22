// The Organization's Analytics overview: every Site with Analytics on or off,
// its setup and the Cloudflare permissions of each Hosting Group, and a bulk
// enable/disable that runs the same per-Site path as update_app.
//
// Approving Cloudflare permissions never turns Analytics on. Measurement is
// opt-in per Site: only a Site enabled here or through update_app gets a
// Web Analytics site, beacon_token and site_tag, and a beacon in its next
// publication.

import { paths, type Site, type SiteApps } from '@typeroll/shared';
import { getStore } from '../datastore';
import { maskAppState } from './config';
import { AppManagementError, incompleteSetupError, saveAppState } from './manage';
import { getHostingGroup } from '../publishing/hosting-groups';
import { cloudflarePermissionReports, type CloudflarePermissionReport } from '../publishing/cloudflare-capabilities';
import { ConnectionError } from '../publishing/connections';

export const ANALYTICS_BULK_LIMIT = 50;

export interface AnalyticsSiteRow {
  site_id: string;
  name: string;
  publishing_mode: string;
  /** Customer publishing only: the Hosting Group whose Cloudflare account holds the Site's Analytics. */
  hosting_group_id: string | null;
  hosting_group_name: string | null;
  enabled: boolean;
  /** Ready, or the cause and next step. Null while Analytics has never been enabled. */
  setup: ReturnType<typeof maskAppState>['setup'] | null;
  /** Whether a beacon token is saved; the token itself is published in the Site's HTML but not listed here. */
  beacon_configured: boolean;
}

export interface AnalyticsOverview {
  sites: AnalyticsSiteRow[];
  /** Cloudflare permissions of every Hosting Group: approving them enables Analytics for no Site. */
  cloudflare_permissions: CloudflarePermissionReport[];
}

const archived = (site: Site) => site.lifecycle?.status === 'archived';

export async function readAnalyticsOverview(orgId: string): Promise<AnalyticsOverview> {
  const store = getStore();
  const sites = (await store.listDocs<Site>(paths.sites(orgId))).filter(site => !archived(site))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  const groupNames = new Map<string, string>();
  const rows = await Promise.all(sites.map(async (site): Promise<AnalyticsSiteRow> => {
    const doc = await store.getDoc<SiteApps>(paths.apps(orgId, site.id));
    const state = doc?.apps?.analytics;
    const masked = maskAppState('analytics', state);
    const customer = site.publishing_mode === 'customer_git';
    const groupId = customer ? site.hosting_group_id ?? 'default' : null;
    if (groupId && !groupNames.has(groupId)) groupNames.set(groupId, await getHostingGroup(orgId, groupId).then(group => group.name, () => groupId));
    return {
      site_id: site.id, name: site.name ?? site.id, publishing_mode: site.publishing_mode ?? 'managed',
      hosting_group_id: groupId, hosting_group_name: groupId ? groupNames.get(groupId) ?? groupId : null,
      enabled: masked.enabled, setup: state?.enabled ? masked.setup ?? null : null,
      beacon_configured: typeof state?.config?.beacon_token === 'string' && state.config.beacon_token.length > 0,
    };
  }));
  return { sites: rows, cloudflare_permissions: await cloudflarePermissionReports(orgId) };
}

export interface AnalyticsChangeResult {
  site_id: string;
  enabled: boolean;
  /** ready / action_required: Analytics is on. disabled: off. error: nothing was changed; `enabled` is the Site's current state. */
  status: 'ready' | 'action_required' | 'disabled' | 'error';
  code?: string;
  message?: string;
  next_step?: string;
  settings_url?: string;
  setup?: AnalyticsSiteRow['setup'];
}

/** Parse `{ sites: [{ site_id, enabled }] }`. */
export function analyticsChanges(body: unknown): Array<{ site_id: string; enabled: boolean }> {
  const sites = (body as { sites?: unknown } | null)?.sites;
  if (!Array.isArray(sites) || !sites.length) throw new ConnectionError('Send sites: [{ site_id, enabled }] with at least one Site.', 400, 'invalid_request');
  if (sites.length > ANALYTICS_BULK_LIMIT) throw new ConnectionError(`Change at most ${ANALYTICS_BULK_LIMIT} Sites per request.`, 400, 'invalid_request');
  const seen = new Set<string>();
  return sites.map((item) => {
    const siteId = (item as { site_id?: unknown })?.site_id, enabled = (item as { enabled?: unknown })?.enabled;
    if (typeof siteId !== 'string' || !siteId || typeof enabled !== 'boolean') throw new ConnectionError('Each entry needs site_id (string) and enabled (boolean).', 400, 'invalid_request');
    if (seen.has(siteId)) throw new ConnectionError(`Site ${siteId} is listed more than once.`, 400, 'invalid_request');
    seen.add(siteId);
    return { site_id: siteId, enabled };
  });
}

/**
 * Turn Analytics on or off for the chosen Sites, one at a time, through the same path as update_app (Web Analytics
 * provisioning in the Site's hosting account). Sites that are not listed are not touched. One Site's failure does
 * not stop the others; each result says what happened.
 */
export async function setOrganizationAnalytics(orgId: string, changes: Array<{ site_id: string; enabled: boolean }>, fetchImpl: typeof fetch = fetch): Promise<AnalyticsChangeResult[]> {
  const store = getStore();
  const results: AnalyticsChangeResult[] = [];
  for (const change of changes) {
    const site = /^[\w-]{1,128}$/.test(change.site_id) ? await store.getDoc<Site>(paths.site(orgId, change.site_id)) : null;
    if (!site || archived(site)) {
      results.push({ site_id: change.site_id, enabled: false, status: 'error', code: 'site_not_found', message: 'No active Site with this id in this Organization.' });
      continue;
    }
    try {
      const saved = await saveAppState({ orgId, siteId: change.site_id, appId: 'analytics', enabled: change.enabled, fetchImpl });
      const setup = maskAppState('analytics', saved.state).setup ?? null;
      if (!change.enabled) { results.push({ site_id: change.site_id, enabled: false, status: 'disabled' }); continue; }
      const incomplete = incompleteSetupError('analytics', saved.state, saved.setup);
      results.push(incomplete
        ? { site_id: change.site_id, enabled: true, status: 'action_required', code: incomplete.code, message: incomplete.message,
          next_step: saved.setup?.next_step, ...(saved.setup?.settings_url ? { settings_url: saved.setup.settings_url } : {}), setup }
        : { site_id: change.site_id, enabled: true, status: saved.setup?.status === 'action_required' ? 'action_required' : 'ready', setup });
    } catch (error) {
      const current = (await store.getDoc<SiteApps>(paths.apps(orgId, change.site_id)))?.apps?.analytics;
      results.push({ site_id: change.site_id, enabled: Boolean(current?.enabled), status: 'error', code: error instanceof AppManagementError ? error.code ?? 'app_error' : 'app_error',
        message: error instanceof Error ? error.message : 'Analytics could not be changed for this Site.' });
    }
  }
  return results;
}
