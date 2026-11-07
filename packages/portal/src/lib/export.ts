// Customer content export — the anti-lock-in feature. Zips the site's full
// content tree (site, apps projection, version, settings, pages, partials,
// redirects, block types, page templates, content types, forms, media docs) as
// JSON files in the fixtures layout the OSS site-template builds from: an
// exported zip unpacked into a fixtures dir IS a working local site.
//
// The snapshot is read from the store and assembled in memory. Every versioned
// collection is chain-resolved (resolvePublicationVersion), so a branch export
// inherits main's non-overridden docs.
//
// Media BINARIES are not included (they live on the CDN); the media docs in
// the zip carry every cdn_url + variant URL, listed flat in the manifest so
// a mirror script is a one-liner per file.

import JSZip from 'jszip';
import { DEFAULT_CONTENT_TYPE, MAIN_VERSION_ID, paths, publicContentPage } from '@typeroll/shared';
import type { Form, Media, Site, SiteApps, SiteVersion } from '@typeroll/shared';
import { getStore } from './datastore';
import { resolvePublicationVersion } from './publishing/publication-version';

export const EXPORT_FORMAT_VERSION = 1;

export interface ContentExport {
  zip: Uint8Array;
  filename: string;
}

type Store = ReturnType<typeof getStore>;
/** Document path (without `.json`) → document data without its id. */
export type ContentSnapshot = Map<string, Record<string, unknown>>;

function assertPublicSubmitUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Cannot export ${label}: configure FORMS_PUBLIC_URL or PORTAL_PUBLIC_URL with an absolute URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Cannot export ${label}: the public submit endpoint must use HTTPS`);
  }
}

/**
 * The chain-resolved content of one site version, keyed by document path. The
 * id is encoded in the path, so it is left out of each document.
 */
export async function contentSnapshot(store: Store, orgId: string, siteId: string, versionId: string): Promise<ContentSnapshot> {
  const docs: ContentSnapshot = new Map();
  const put = (docPath: string, data: Record<string, unknown>) => {
    const { id: _ignored, ...rest } = data;
    docs.set(docPath, rest);
  };

  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new Error('Site disappeared');
  const resolved = await resolvePublicationVersion(orgId, siteId, versionId);
  // The Turnstile secret stays on the server; forms get only the public site key below.
  const { form_turnstile: _turnstile, ...exportSite } = site;
  put(paths.site(orgId, siteId), exportSite as Record<string, unknown>);

  // Apps: ONLY the public projection of enabled apps (enabled flag + each
  // app's declared public config, e.g. the analytics beacon token). Secrets
  // and server-only config never leave the store; the integrations doc is
  // deliberately not exported.
  {
    const appsDoc = await store.getDoc<SiteApps>(paths.apps(orgId, siteId));
    const { publicAppsSnapshot } = await import('./apps/config');
    const publicApps = publicAppsSnapshot(appsDoc ?? undefined);
    if (publicApps.apps?.analytics?.enabled) {
      const { analyticsEventEmbedInfo } = await import('./apps/analytics-events');
      const embed = analyticsEventEmbedInfo(orgId, siteId);
      if (embed.event_endpoint && embed.event_token) {
        publicApps.apps.analytics.config = { ...publicApps.apps.analytics.config, ...embed };
      }
    }
    if (Object.keys(publicApps.apps ?? {}).length > 0) put(paths.apps(orgId, siteId), publicApps as unknown as Record<string, unknown>);
  }

  // External Extensions: only enabled installations, public config, URL-context
  // declarations and immutable asset metadata. Secret config is never exported.
  {
    const { buildExtensionRuntimeSnapshot } = await import('./extensions/runtime-snapshot');
    const extensionSnapshot = await buildExtensionRuntimeSnapshot(orgId, siteId);
    if (extensionSnapshot.installations.length > 0) {
      put(paths.extensionRuntimeSnapshot(orgId, siteId), extensionSnapshot as unknown as Record<string, unknown>);
    }
  }

  // Version doc — the renderer reads it to decide robots-blocking, so it is
  // exported even when it is just the implicit "main" placeholder.
  const versionDoc = await store.getDoc<SiteVersion>(paths.version(orgId, siteId, versionId));
  if (versionDoc) {
    put(paths.version(orgId, siteId, versionId), versionDoc as unknown as Record<string, unknown>);
  } else if (versionId === MAIN_VERSION_ID) {
    put(paths.version(orgId, siteId, versionId), {
      name: 'Main', kind: 'main', created_at: site.created_at ?? new Date().toISOString(), robots_blocked: false,
    });
  }

  if (resolved.settings) put(paths.settings(orgId, siteId, versionId), resolved.settings as unknown as Record<string, unknown>);
  for (const partial of resolved.partials) put(`${paths.partials(orgId, siteId, versionId)}/${partial.id}`, partial as unknown as Record<string, unknown>);
  // Menus (render version 15): the site-template reads them next to the partials.
  for (const menu of resolved.menus) put(paths.menu(orgId, siteId, menu.id, versionId), menu as unknown as Record<string, unknown>);
  // Site fields: values for {{site.fields.*}} and core/site_field, with their definitions.
  if (resolved.siteFields && (resolved.siteFields.groups.length || Object.keys(resolved.siteFields.values ?? {}).length)) {
    put(paths.siteFields(orgId, siteId, versionId), resolved.siteFields as unknown as Record<string, unknown>);
  }

  // Pages — only published and unlisted ones are public content.
  const typeIndex = new Map(resolved.contentTypes.map(type => [type.id, type]));
  if (!typeIndex.has('page')) typeIndex.set('page', DEFAULT_CONTENT_TYPE);
  for (const page of resolved.pages) {
    if (page.status === 'draft' || page.status === 'review') continue;
    const type = typeIndex.get(page.content_type ?? 'page');
    if (!type) throw new Error(`Unknown content type for page ${page.id}`);
    put(`${paths.pages(orgId, siteId, versionId)}/${page.id}`, publicContentPage(page, type) as unknown as Record<string, unknown>);
  }

  for (const redirect of resolved.redirects) put(`${paths.redirects(orgId, siteId, versionId)}/${redirect.id}`, redirect as unknown as Record<string, unknown>);
  for (const blockType of resolved.blockTypes) {
    if (blockType.id) put(`${paths.blockTypes(orgId, siteId, versionId)}/${blockType.id}`, blockType as unknown as Record<string, unknown>);
  }
  for (const template of resolved.pageTemplates) {
    if (template.id) put(`${paths.pageTemplates(orgId, siteId, versionId)}/${template.id}`, template as unknown as Record<string, unknown>);
  }
  for (const type of resolved.contentTypes) put(paths.contentType(orgId, siteId, type.id, versionId), type as unknown as Record<string, unknown>);

  // Forms carry their public embed info (submit_url, signed token, proof-of-work
  // difficulty), so form blocks render complete working markup without secrets.
  {
    const { formEmbedInfo, POW_BITS } = await import('./forms-signing');
    const { publicTurnstileSiteKey } = await import('./forms/turnstile');
    const { resolveAppFormEndpoint } = await import('./apps/form-endpoint');
    const turnstileSiteKey = publicTurnstileSiteKey(site);
    for (const form of await store.listDocs<Record<string, unknown>>(paths.forms(orgId, siteId))) {
      const id = (form as { id?: string }).id;
      if (!id) continue;
      // Post-submit actions are server-only and may contain encrypted secrets.
      const exportForm = { ...form };
      delete exportForm.actions;
      const appEndpoint = await resolveAppFormEndpoint(form as { target?: Form['target'] }, {
        orgId, siteId, portalUrl: (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, ''),
      });
      if (appEndpoint) {
        assertPublicSubmitUrl(appEndpoint.submit_url, `core module form ${id}`);
        put(`${paths.forms(orgId, siteId)}/${id}`, { ...exportForm, ...appEndpoint });
        continue;
      }
      const embed = formEmbedInfo(orgId, siteId, id);
      assertPublicSubmitUrl(embed.submit_url, `form ${id}`);
      put(`${paths.forms(orgId, siteId)}/${id}`, {
        ...exportForm,
        submit_url: embed.submit_url,
        submit_token: embed.submit_token,
        pow_bits: POW_BITS,
        ...(turnstileSiteKey ? { turnstile_site_key: turnstileSiteKey } : {}),
      });
    }
  }

  // Media docs resolve CDN URLs to variants and source dimensions. Media is
  // per site, not per version.
  for (const media of await store.listDocs<Record<string, unknown>>(paths.media(orgId, siteId))) {
    if ((media as { id?: string }).id) put(`${paths.media(orgId, siteId)}/${(media as { id: string }).id}`, media);
  }
  return docs;
}

export async function buildContentExport(
  orgId: string,
  siteId: string,
  versionId: string,
): Promise<ContentExport> {
  const store = getStore();
  const zip = new JSZip();
  for (const [docPath, data] of await contentSnapshot(store, orgId, siteId, versionId)) {
    zip.file(`${docPath}.json`, JSON.stringify(data, null, 2));
  }

  // Flat media URL list — everything a mirror script needs to also pull the
  // binaries. Best-effort: an unreadable media collection never blocks a
  // content export.
  let mediaUrls: string[] = [];
  try {
    const media = await store.listDocs<Media>(paths.media(orgId, siteId));
    mediaUrls = media.flatMap((m) => [
      ...(m.cdn_url ? [m.cdn_url] : []),
      ...(m.variants ?? []).map((v) => v.cdn_url).filter((u): u is string => !!u),
    ]);
  } catch {
    /* media listing is optional */
  }

  zip.file(
    'export-manifest.json',
    JSON.stringify(
      {
        format: 'typeroll-content-export',
        format_version: EXPORT_FORMAT_VERSION,
        site_id: siteId,
        version_id: versionId,
        exported_at: new Date().toISOString(),
        notes: [
          'The fixtures tree in this zip is the exact layout the Typeroll site-template builds from: point TYPEROLL_FIXTURES_DIR at the unpacked directory for a working local site.',
          'Media binaries are not included; media_urls lists every original + variant CDN URL for mirroring.',
        ],
        media_urls: mediaUrls,
      },
      null,
      2,
    ),
  );

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip: bytes, filename: `${siteId}-content-${stamp}.zip` };
}
