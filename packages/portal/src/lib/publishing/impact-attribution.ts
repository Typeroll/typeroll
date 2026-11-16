import { paths, type ExtensionAuditEvent, type ExtensionInstallation, type SiteApps } from '@typeroll/shared';
import { getStore } from '../datastore';
import { resolveExtensionVersion } from '../extensions/resolution';
import type { ApiAuditEntry } from '../api-audit';
import type { PublicationImpact, ConfigurationChangeSource } from './impact';
export type { ConfigurationChangeSource };


const SOURCES_SHOWN = 10;
/** Configuration entries and the API routes that change them. */
const ROUTES: Record<string, RegExp> = {
  extensions: /\/extensions(\/|$)/, runtime_dependencies: /\/(extensions|forms|apps)(\/|$)/, apps: /\/apps(\/|$)/,
  settings: /\/settings(\/|$)|\/cookie-consent|\/custom-css/, site: /\/settings(\/|$)|\/site(\/|$)|\/sites\/[^/]+$/, siteFields: /\/site-fields/,
};
const after = (value: string | null | undefined, since: string) => typeof value === 'string' && value > since;
/** The extension a path belongs to: `installations[<id>]…` in Extensions, `[extension:<id>]…` in Runtime connections. */
const extensionOf = (path: string) => /^installations\[([^\]]+)\]/.exec(path)?.[1] ?? /^\[extension:([^\]]+)\]/.exec(path)?.[1];

/**
 * Attribute each changed configuration entry of a comparison to the records
 * that changed after the baseline was published. Read only; best effort:
 * changes made in the portal before Core 0.3.36 left no actor, only times.
 */
export async function attributeConfigurationChanges(orgId: string, siteId: string, since: string | null | undefined, impact: PublicationImpact): Promise<void> {
  const changed = impact.changes.filter(change => change.kind === 'configuration' && change.action === 'changed');
  if (!changed.length || !since) return;
  const store = getStore();
  const [installations, audit, api, apps] = await Promise.all([
    store.listDocs<ExtensionInstallation>(paths.extensionInstallations(orgId, siteId)).catch(() => []),
    store.listDocs<ExtensionAuditEvent>(paths.extensionAudit(orgId, siteId), { filters: [{ field: 'created_at', op: '>', value: since }], limit: 50 }).catch(() => []),
    store.listDocs<ApiAuditEntry>(paths.apiAudit(orgId, siteId), { filters: [{ field: 'ts', op: '>', value: since }], limit: 100 }).catch(() => []),
    store.getDoc<SiteApps>(paths.apps(orgId, siteId)).catch(() => null),
  ]);
  const releases = new Map<string, ConfigurationChangeSource>();
  for (const installation of installations) {
    const resolution = await resolveExtensionVersion(installation).catch(() => null);
    const published = (resolution?.version as { published_at?: string } | null | undefined)?.published_at;
    if (resolution?.automatically_updated && resolution.version && after(published, since)) {
      releases.set(installation.extension_id, { source: 'extension_release', at: published ?? null, extension_id: installation.extension_id, version: resolution.version.version,
        summary: `${installation.extension_id} ${resolution.version.version} was published by its developer and is used automatically; no one changed this site.` });
    }
  }
  for (const change of changed) {
    const sources: ConfigurationChangeSource[] = [];
    const paths = (change.details ?? []).map(detail => detail.path);
    const extensions = new Set(paths.map(extensionOf).filter((id): id is string => Boolean(id)));
    if (['extensions', 'runtime_dependencies'].includes(change.id)) {
      for (const installation of installations) {
        if (extensions.size && !extensions.has(installation.extension_id)) continue;
        const release = releases.get(installation.extension_id);
        if (release) sources.push(release);
        if (after(installation.updated_at, since)) sources.push({ source: 'installation', at: installation.updated_at, extension_id: installation.extension_id, summary: `The ${installation.extension_id} installation on this site was changed.` });
      }
      for (const event of audit) {
        if (extensions.size && !extensions.has(event.extension_id)) continue;
        sources.push({ source: 'extension_audit', at: event.created_at, extension_id: event.extension_id, action: event.action, ...(event.actor_id ? { actor_id: event.actor_id } : {}), summary: `${event.action} for ${event.extension_id}.` });
      }
    }
    if (change.id === 'runtime_dependencies' && (change.details ?? []).some(detail => /\.endpoint$/.test(detail.path) && detail.before && detail.after && new URL(detail.before, 'https://x').host !== new URL(detail.after, 'https://x').host)) {
      sources.push({ source: 'platform', at: null, summary: 'An endpoint address moved to another host. Form and app endpoints are derived from this Typeroll installation’s public addresses, not from the site.' });
    }
    if (['apps', 'runtime_dependencies'].includes(change.id) && after(apps?.updated_at, since)) sources.push({ source: 'apps', at: apps!.updated_at!, summary: 'The site’s apps were changed.' });
    const route = ROUTES[change.id];
    if (route) for (const entry of api) {
      if (entry.status >= 400 || !route.test(entry.path)) continue;
      sources.push({ source: 'api', at: entry.ts, action: entry.method, route: entry.path, ...(entry.actor_user_id ? { actor_id: entry.actor_user_id } : {}), summary: `${entry.method} ${entry.path} through an API key (${entry.key_prefix}).` });
    }
    sources.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    change.changed_by = sources.slice(0, SOURCES_SHOWN);
  }
}
