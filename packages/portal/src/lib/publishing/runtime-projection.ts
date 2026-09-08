import { paths, type Form, type SiteApps } from '@typeroll/shared';
import { getStore } from '../datastore';
import { publicAppsSnapshot } from '../apps/config';
import { buildExtensionRuntimeSnapshot } from '../extensions/runtime-snapshot';
import { formEmbedInfo, POW_BITS } from '../forms-signing';
import { resolveAppFormEndpoint } from '../apps/form-endpoint';
import { parsePublicHttpsUrl } from '../extensions/public-http';

/** Reuse the same public runtime contracts as preview and managed builds. No action credentials cross this boundary. */
export async function publicationRuntime(orgId: string, siteId: string) {
  const store = getStore();
  const [storedApps, storedForms, extensions] = await Promise.all([
    store.getDoc<SiteApps>(paths.apps(orgId, siteId)), store.listDocs<Form>(paths.forms(orgId, siteId)),
    buildExtensionRuntimeSnapshot(orgId, siteId, { reconcileBlocks: false, strict: true }),
  ]);
  const apps = publicAppsSnapshot(storedApps ?? undefined);
  if (apps.apps?.analytics?.enabled) {
    const { analyticsEventEmbedInfo } = await import('../apps/analytics-events');
    apps.apps.analytics.config = { ...apps.apps.analytics.config, ...analyticsEventEmbedInfo(orgId, siteId) };
  }
  const forms = storedForms.map(form => {
    const endpoint = resolveAppFormEndpoint(form, { siteId, portalUrl: (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '') }) ||
      { ...formEmbedInfo(orgId, siteId, form.id), pow_bits: POW_BITS };
    parsePublicHttpsUrl(endpoint.submit_url);
    return { id: form.id, name: form.name, kind: form.kind, submit_text: form.submit_text, success_message: form.success_message,
      styles: form.styles, steps: form.steps, ...endpoint };
  });
  const dependencies = [
    ...forms.map(form => ({ kind: 'forms', id: form.id, endpoint: form.submit_url })),
    ...extensions.installations.map(installation => ({ kind: 'extension', id: installation.extension_id, version: installation.version,
      ...(installation.api ? { endpoint: installation.api.base_url } : {}) })),
    ...Object.keys(apps.apps ?? {}).map(id => ({ kind: 'app', id })),
  ];
  return { apps, forms, extensions, dependencies };
}
