// Deploy runner.
//
// Given an org+site, this:
//   1. Materializes the site's content into a fixtures dir for the
//      site-template build (so the same renderer used by self-hosted
//      installs runs with consistent inputs).
//   2. Runs `astro build` in the site-template package as a child process.
//   3. Generates _redirects from the redirects collection.
//   4. Hands the build directory to the configured hosting adapter.
//
// The materialize step is what lets us run one build per site without
// patching the site-template's data layer at runtime.
//
// INVARIANT — the build reads the snapshot, not live Firestore. The Astro
// build is pointed at the fixtures via TYPEROLL_FIXTURES_DIR, and the
// site-template's getStore() treats an explicit fixtures dir as the source of
// truth even when FIREBASE_SERVICE_ACCOUNT is present in the env (it is, on
// Cloud Run). So materializeFixtures must write EVERY doc-path the renderer
// reads, and read each via vstore (chain-fallback) so a branch inherits what
// it didn't override. Miss a path and a branch deploy renders that slice empty
// or with defaults (lang=en, Inter, "New Site") — main hides it because main
// is the base of the chain. When you add a renderer read, add it here too.

import fs from 'node:fs';
import { vstore } from '../version-store';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCollectionRoutes,
  expandRedirectsForTrailingSlashPolicy,
  paths,
  MAIN_VERSION_ID,
} from '@typeroll/shared';
import type { CollectionItem, ExtensionRuntimeSnapshot, Form, Page, Redirect, Site, SiteApps, SiteSettings, SiteVersion, Partial as PartialDoc, TrailingSlashPolicy } from '@typeroll/shared';
import { getStore } from '../datastore';
import { pageUrlFromDoc } from '../page-paths';
import { partitionShadowedRedirects } from '../redirect-hygiene';
import { getHostingAdapter } from '../hosting';
import { isCanonicalReady } from '../site-public-urls';
import type { DeployResult } from '../hosting';

export interface RunDeployArgs {
  orgId: string;
  siteId: string;
  environment: 'staging' | 'production';
  /** Override the URL the build should think it lives at (for sitemap, canonicals). */
  siteUrl?: string;
  /** Version of the site to build. Defaults to main. */
  versionId?: string;
  /** When true, skip the network deploy and just return the build dir. */
  buildOnly?: boolean;
  /** Called with each phase label so background jobs can write progress. */
  onPhase?: (phase: string) => void | Promise<void>;
}

export interface RunDeployResult {
  buildDir: string;
  fixturesDir: string;
  deploy?: DeployResult;
  /** Size of the generated site. Recorded on the deploy job's cost row so the
   *  build-cost report can show what a build actually produced. */
  outputBytes?: number;
  outputFiles?: number;
  warnings?: string[];
}

function repoRoot(): string {
  // packages/portal/src/lib/deploy → repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '..', '..', '..'),
    path.resolve(here, '..', '..', '..', '..'),
    process.cwd(),
    path.resolve(process.cwd(), '..', '..'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'packages', 'site-template', 'package.json'))) return c;
  }
  // Fallback to two-up from cwd
  return path.resolve(process.cwd(), '..', '..');
}

export async function runDeploy(args: RunDeployArgs): Promise<RunDeployResult> {
  const store = getStore();
  const phase = async (p: string) => { await args.onPhase?.(p); };

  await phase('preparing');
  const site = await store.getDoc<Site>(paths.site(args.orgId, args.siteId));
  if (!site) throw new Error(`Site not found: ${args.siteId}`);

  const versionId = args.versionId ?? MAIN_VERSION_ID;
  const warnings: string[] = [];

  // Internal links are checked against the exact versioned datastore that
  // will be materialized below. Broken links warn instead of blocking the
  // deploy, so an emergency publish remains possible and the finding stays
  // visible on the resulting deploy job.
  await phase('checking internal links');
  try {
    const { checkInternalLinks } = await import('../internal-link-check');
    const report = await checkInternalLinks({
      store,
      orgId: args.orgId,
      siteId: args.siteId,
      versionId,
      site,
    });
    if (report.broken_links > 0) {
      const examples = report.broken.slice(0, 3).map((entry) => `${entry.from} → ${entry.href}`).join('; ');
      warnings.push(`${report.broken_links} broken internal link(s) found${examples ? `: ${examples}` : ''}`);
      console.warn(`[deploy] ${warnings[warnings.length - 1]}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Internal link preflight could not complete: ${message}`);
    console.warn(`[deploy] ${warnings[warnings.length - 1]}`);
  }

  // 0. Backfill missing media variants. Every uploader (in-portal UI +
  //    MCP `upload_media_from_url`/`_inline`) calls finalize automatically
  //    these days, but legacy uploads from before the finalize pipeline +
  //    failed finalize calls leave media with no `variants` array. We
  //    detect that here and bulk-finalize once per deploy so the
  //    build-time SEO transform downstream actually has variants to
  //    reference. Cheap when there's nothing to do (one listDocs +
  //    short-circuit). Best-effort: deploys don't fail if a single
  //    image can't be finalized.
  await phase('backfilling media variants');
  await backfillMediaVariants(args.orgId, args.siteId);

  // 1. Write content into a temp fixtures dir.
  await phase('materializing content');
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tr-build-${args.siteId}-${versionId}-`));
  const fixturesDir = path.join(tmpBase, 'fixtures');
  const { buildExtensionRuntimeSnapshot } = await import('../extensions/runtime-snapshot');
  const extensionSnapshot = await buildExtensionRuntimeSnapshot(args.orgId, args.siteId);
  await materializeFixtures(store, args.orgId, args.siteId, versionId, fixturesDir, extensionSnapshot);

  // 2. Run astro build with site-scoped env vars.
  await phase('building');
  const root = repoRoot();
  const siteTemplateDir = path.join(root, 'packages', 'site-template');
  const buildDir = path.join(tmpBase, 'dist');
  // Canonical URL the static build bakes into sitemap.xml + JSON-LD.
  //
  // Precedence (production), domain-first model:
  //   1. The custom domain — as soon as one is DECLARED (isCanonicalReady =
  //      !!site.domain), independent of DNS-verification status. The customer
  //      enters the domain first; we bake it as canonical and republish; they
  //      point DNS last. This is what guarantees the public site never
  //      advertises the internal `*.sites` fallback as canonical (the
  //      autopilot.sites.typeroll.com → autopilot.se sitemap leak).
  //   2. The Cloudflare Pages fallback subdomain when no domain is declared
  //      (the develop-on-the-subdomain phase). The hosting platform's single
  //      zone-level response-header rule keeps that host out of search indexes.
  //   3. Portal preview URL as a last resort. Works for any portal
  //      caller; not ideal for indexing but better than the old
  //      `example.com` placeholder.
  //
  // The fallback noindex defense is intentionally outside this site build.
  // Customer Pages projects remain static and receive no middleware Function.
  const portalOrigin = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  const previewFallback = portalOrigin ? `${portalOrigin}/preview/${args.siteId}` : '';
  // Canonical-ready = the custom domain is verified (or live) on Cloudflare,
  // pair-safe — i.e. it's being served publicly, so it's the canonical host.
  // NOT the same as the dashboard "activated/live" flag (publicUrlsFor).
  const canonicalReady = isCanonicalReady(site);
  const fallbackSubdomain = site.hosting_config?.fallback_subdomain;
  const fallbackUrl = fallbackSubdomain ? `https://${fallbackSubdomain}` : previewFallback;
  const siteUrl =
    args.siteUrl ??
    (args.environment === 'production'
      ? canonicalReady
        ? `https://${site.domain}`
        : fallbackUrl
      : site.staging_url ?? fallbackUrl);

  await spawnAstroBuild({
    cwd: siteTemplateDir,
    outDir: buildDir,
    env: {
      TYPEROLL_ORG_ID: args.orgId,
      TYPEROLL_SITE_ID: args.siteId,
      TYPEROLL_SITE_URL: siteUrl,
      TYPEROLL_VERSION_ID: versionId,
      TYPEROLL_FIXTURES_DIR: fixturesDir,
    },
  });
  // Sanity-check that astro actually produced something — astro silently
  // exits 0 when it has zero pages to render, leaving the dist dir
  // missing or empty. That's almost always a config/fixtures problem the
  // user should hear about explicitly.
  let buildContents: string[] = [];
  try {
    buildContents = await fs.promises.readdir(buildDir);
  } catch { /* dir doesn't exist */ }
  console.log(`[deploy] astro produced ${buildContents.length} entries in ${buildDir}: ${buildContents.slice(0, 10).join(', ')}`);
  if (buildContents.length === 0) {
    throw new Error(
      `astro build produced no output in ${buildDir}. Likely causes: no published pages on the site, or the site-template can't read TYPEROLL_FIXTURES_DIR=${fixturesDir}.`,
    );
  }

  // Extension bundles are fetched from the immutable version manifest,
  // verified again at deploy time, and copied under the customer site's own
  // asset namespace. Runtime code never imports the mutable provider URL.
  if (extensionSnapshot.installations.length > 0) {
    await phase('vendoring extension assets');
    const { vendorExtensionAssets } = await import('../extensions/assets');
    const vendored = await vendorExtensionAssets(buildDir, extensionSnapshot);
    console.log(`[deploy] extensions: vendored ${vendored.files} files (${vendored.bytes} bytes)`);
  }

  // 2b. Roll up inlined block CSS / JS into one cached bundle per type.
  //     BaseLayout writes inline tags per page — this pass extracts and
  //     consolidates them so multi-page sites stop shipping the same
  //     bytes in every HTML file. Result: dist/_assets/blocks-{hash}.css
  //     (and .js) plus rewritten HTML files referencing the shared URL.
  await phase('bundling block assets');
  const { bundleBlockAssets } = await import('./bundle-blocks');
  const bundleResult = await bundleBlockAssets(buildDir);
  if (bundleResult.css_url || bundleResult.js_url) {
    console.log(
      `[deploy] block bundle: rewrote ${bundleResult.files_rewritten} files, ` +
      `saved ${bundleResult.css_bytes_saved} CSS + ${bundleResult.js_bytes_saved} JS bytes ` +
      `(css=${bundleResult.css_url ?? '-'} js=${bundleResult.js_url ?? '-'})`,
    );
  }

  // 2c. Site search: when any page uses the core/search block, index the
  //     built HTML with Pagefind (writes {buildDir}/pagefind/ — the assets
  //     the block's client script loads). Skipped entirely otherwise.
  await phase('indexing search');
  const { buildSearchIndexIfUsed } = await import('./search-index');
  const searchResult = await buildSearchIndexIfUsed(buildDir);
  if (searchResult.indexed) {
    console.log(`[deploy] pagefind: indexed ${searchResult.page_count ?? '?'} pages`);
  }

  // 3. Write _redirects.
  await phase('writing redirects');
  const siteForRedirect = await getStore().getDoc<Site>(paths.site(args.orgId, args.siteId));
  const [redirects, pagesForRedirects, collectionsForRedirects, redirectSettings] = await Promise.all([
    vstore.redirects(args.orgId, args.siteId, versionId),
    vstore.pages(args.orgId, args.siteId, versionId),
    vstore.collections(args.orgId, args.siteId, versionId),
    vstore.settings(args.orgId, args.siteId, versionId),
  ]);
  // Belt-and-braces: never emit a rule whose from_path a built page owns.
  // CF Pages serves redirects BEFORE static files, so such a rule shadows
  // the page entirely (a stale "/" auto-redirect once hid a site's brand-new
  // home page). The write surfaces retire these eagerly; this guard catches
  // anything that slipped through.
  const liveUrls = new Set(
    pagesForRedirects
      .filter((p) => p.status === 'published' || p.status === 'unlisted')
      .map((p) => pageUrlFromDoc(p)),
  );
  const collectionItems = new Map<string, CollectionItem[]>();
  await Promise.all(collectionsForRedirects.map(async (collection) => {
    collectionItems.set(
      collection.name,
      await vstore.collectionItems(args.orgId, args.siteId, versionId, collection.name),
    );
  }));
  for (const route of buildCollectionRoutes(collectionsForRedirects, collectionItems)) {
    liveUrls.add(route.path);
  }
  const { kept: safeRedirects, shadowed, shadowedPages } = partitionShadowedRedirects(redirects, liveUrls);
  for (const r of shadowed) {
    const hits = shadowedPages.get(r) ?? [r.from_path];
    const owned = hits.slice(0, 5).join(', ') + (hits.length > 5 ? `, +${hits.length - 5} more` : '');
    console.warn(
      `[deploy] skipping redirect ${r.from_path} → ${r.to_path}: live page(s) own ${owned} ` +
      `(the rule would shadow them on Cloudflare Pages)`,
    );
  }
  const redirectFile = buildRedirectsFile(
    siteForRedirect,
    safeRedirects,
    redirectSettings?.trailing_slash ?? 'always',
  );
  if (redirectFile) {
    await fs.promises.writeFile(path.join(buildDir, '_redirects'), redirectFile);
    if (siteForRedirect?.domain_alias) {
      console.log(`[deploy] canonical redirect: ${siteForRedirect.domain_alias} → ${siteForRedirect.domain} (force)`);
    }
  }

  // 3b. Write _headers — Cloudflare Pages reads this to set HTTP response
  //     headers per route. We set sensible caching + security defaults; the
  //     customer's own robots/scripts still flow normally.
  //
  //       /static/*    long-lived, immutable (hashed asset filenames)
  //       /*           short HTML cache + must-revalidate so the next deploy
  //                    shows up immediately
  //       sitemap/robots → short cache, gzip-friendly
  //
  //     X-Content-Type-Options + Referrer-Policy + Permissions-Policy are
  //     baseline hardening; they apply to every response.
  const headersFile = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '  Cache-Control: public, max-age=300, must-revalidate',
    '',
    '/_astro/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/_assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/sitemap.xml',
    '  Cache-Control: public, max-age=3600',
    '/sitemap-images.xml',
    '  Cache-Control: public, max-age=3600',
    '/robots.txt',
    '  Cache-Control: public, max-age=3600',
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(buildDir, '_headers'), headersFile);

  // 3c. Validate bound Forms before upload. Extension APIs, Forms and app
  // endpoints are called directly; published customer sites stay static and
  // never receive generated proxy Functions or embedded credentials.
  {
    const { assertDeployableFormBindings } = await import('./form-bindings');
    await assertDeployableFormBindings(
      extensionSnapshot,
      async (formId) => Boolean(await store.getDoc(`${paths.forms(args.orgId, args.siteId)}/${formId}`)),
    );
  }

  // 3d. Measure what the build produced. Best-effort — a stat failure must
  //     never fail a deploy that otherwise succeeded, it just means the cost
  //     row carries no size.
  const output = await measureOutput(buildDir);

  // 4. Optionally hand off to the hosting adapter.
  if (args.buildOnly) {
    await phase('done (build-only)');
    return { buildDir, fixturesDir, ...output, ...(warnings.length ? { warnings } : {}) };
  }

  await phase('uploading');
  const adapter = getHostingAdapter(site.hosting_adapter, site.hosting_config);
  // For non-main versions, pass the version id as the CF Pages branch name
  // so the deploy lands under a stable per-branch URL
  // ({branch}.{project}.pages.dev) the agent can share with the customer
  // for review before merging. Main keeps the default "main" branch which
  // serves at the bare project URL + custom domain.
  const isBranch = versionId !== MAIN_VERSION_ID;
  const deploy = await adapter.deploy(buildDir, {
    environment: args.environment,
    siteId: args.siteId,
    ...(isBranch ? { branchName: versionId } : {}),
  });

  // Persist deploy state on the SiteVersion. last_deployed_at goes on every
  // version (main included) so the editor can show "edits since last deploy"
  // everywhere. deploy_url only goes on non-main branches; main's URL still
  // derives from site.domain (the canonical address).
  //
  // For sites where Main has never been materialized as an explicit doc,
  // ensure required fields exist so /versions listings don't render a row
  // missing name/kind.
  const versionPath = paths.version(args.orgId, args.siteId, versionId);
  const existingVersion = await store.getDoc<SiteVersion>(versionPath);
  const update: Record<string, unknown> = { last_deployed_at: new Date().toISOString() };
  if (deploy?.url && versionId !== MAIN_VERSION_ID) update.deploy_url = deploy.url;
  if (!existingVersion && versionId === MAIN_VERSION_ID) {
    update.name = 'Main';
    update.kind = 'main';
    update.created_at = site.created_at ?? new Date().toISOString();
    update.robots_blocked = false;
  }
  await store.updateDoc(versionPath, update);

  return { buildDir, fixturesDir, deploy, ...output, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Total bytes + file count under a directory. Used only for reporting, so
 * every error is swallowed: a missing/unreadable entry yields a smaller
 * number rather than a failed deploy.
 */
async function measureOutput(dir: string): Promise<{ outputBytes?: number; outputFiles?: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          bytes += st.size;
          files++;
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  try {
    await walk(dir);
  } catch {
    return {};
  }
  return { outputBytes: bytes, outputFiles: files };
}

/**
 * Pre-deploy backfill of media that's missing srcset variants. A media doc
 * needs `variants: MediaVariant[]` for the SEO transform to emit
 * `<picture>` with AVIF + WebP — otherwise the renderer falls back to a
 * bare `<img>` that ships the original PNG at full resolution.
 *
 * Three reasons a doc might lack variants:
 *   1. Uploaded before the finalize pipeline existed (autopilot.se).
 *   2. Uploaded via a code path that doesn't call finalize (legacy clients).
 *   3. Finalize was called but failed (transient sharp/R2 error).
 *
 * This step is cheap when there's nothing to do — one listDocs + a filter.
 * When there's work it can take a while (~1-5s per image), but it only
 * runs once per image: a re-deploy on the same site is a no-op.
 *
 * Best-effort. Errors are logged but don't fail the deploy — a deploy
 * that ships uncached images is still better than a deploy that doesn't
 * ship at all.
 */
async function backfillMediaVariants(orgId: string, siteId: string): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    // R2 not configured (self-hosted-without-R2, dev). Skip silently —
    // there's nothing for finalize to act on either.
    return;
  }

  const store = getStore();
  const media = await store.listDocs<Record<string, unknown>>(paths.media(orgId, siteId));
  // Pre-filter so we only log the count of things that actually need
  // backfilling. A site with 1000 already-finalized images shouldn't
  // log "backfilling 0 images" — it should log nothing.
  const needsBackfill = media.filter((m) => {
    const variants = (m as { variants?: unknown[] }).variants;
    const r2Key = (m as { r2_key?: string }).r2_key;
    const mime = (m as { mime_type?: string }).mime_type;
    if (!r2Key) return false; // legacy doc without r2_key — can't finalize
    if (mime && !mime.startsWith('image/')) return false; // PDF etc.
    return !Array.isArray(variants) || variants.length === 0;
  });
  if (needsBackfill.length === 0) {
    return;
  }
  console.log(`[deploy] backfilling variants for ${needsBackfill.length} media doc(s)…`);

  const { finalizeMedia } = await import('../media-finalize');
  let ok = 0;
  let failed = 0;
  for (const m of needsBackfill) {
    const id = (m as { id?: string }).id;
    if (!id) continue;
    try {
      await finalizeMedia(orgId, siteId, id, {
        accountId, bucket, accessKeyId, secretAccessKey, publicBase,
      });
      ok++;
    } catch (e) {
      failed++;
      console.warn(`[deploy] finalize ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`[deploy] backfill done: ${ok} ok, ${failed} failed`);
}

// Exported for lib/export.ts (customer content export downloads the same
// chain-resolved snapshot a deploy builds from).
export async function materializeFixtures(
  store: ReturnType<typeof getStore>,
  orgId: string,
  siteId: string,
  versionId: string,
  outDir: string,
  providedExtensionSnapshot?: ExtensionRuntimeSnapshot,
): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });

  // Site doc
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new Error('Site disappeared');
  await writeDoc(outDir, paths.site(orgId, siteId), site);

  // Apps: write ONLY the public projection of enabled apps (enabled flag +
  // each app's declared public config, e.g. the analytics beacon token).
  // Secrets and server-only config never reach the build. The integrations
  // doc is deliberately NOT materialized (secrets); the apps doc is, but
  // filtered. Renderer reads this to inject the beacon.
  {
    const appsDoc = await store.getDoc<SiteApps>(paths.apps(orgId, siteId));
    const { publicAppsSnapshot } = await import('../apps/config');
    const publicApps = publicAppsSnapshot(appsDoc ?? undefined);
    if (publicApps.apps?.analytics?.enabled) {
      const { analyticsEventEmbedInfo } = await import('../apps/analytics-events');
      const embed = analyticsEventEmbedInfo(orgId, siteId);
      if (embed.event_endpoint && embed.event_token) {
        publicApps.apps.analytics.config = {
          ...publicApps.apps.analytics.config,
          ...embed,
        };
      }
    }
    if (Object.keys(publicApps.apps ?? {}).length > 0) {
      await writeDoc(outDir, paths.apps(orgId, siteId), publicApps);
    }
  }

  // External Extensions: a separate public projection containing only
  // enabled installations, public config, URL-context declarations and
  // immutable asset metadata. Secret/private config never reaches fixtures.
  {
    const extensionSnapshot = providedExtensionSnapshot ??
      await (await import('../extensions/runtime-snapshot')).buildExtensionRuntimeSnapshot(orgId, siteId);
    if (extensionSnapshot.installations.length > 0) {
      await writeDoc(outDir, paths.extensionRuntimeSnapshot(orgId, siteId), extensionSnapshot);
    }
  }

  // Version doc — the renderer reads this to decide robots-blocking, so
  // ship it even when it's just the implicit "main" placeholder.
  const versionDoc = await store.getDoc<SiteVersion>(paths.version(orgId, siteId, versionId));
  if (versionDoc) {
    await writeDoc(outDir, paths.version(orgId, siteId, versionId), versionDoc);
  } else if (versionId === MAIN_VERSION_ID) {
    await writeDoc(outDir, paths.version(orgId, siteId, versionId), {
      name: 'Main',
      kind: 'main',
      created_at: site.created_at ?? new Date().toISOString(),
      robots_blocked: false,
    });
  }

  // Settings (singleton)
  const settings = await vstore.settings(orgId, siteId, versionId);
  // Instrumentation kept after the branch-deploy-defaults fix: it pins what
  // ends up in the snapshot the build now reads. (The original bug — branch
  // deploys rendering with defaultSiteSettings while main + preview were
  // correct — was the build reading live Firestore with no chain-fallback,
  // not a resolution failure here; see the INVARIANT in this file's header.)
  // resolved should be true for every site, branch or main.
  console.log(
    `[deploy] settings: version=${versionId} resolved=${!!settings} ` +
      `lang=${settings?.language ?? 'none'} heading_font=${settings?.fonts?.heading ?? 'none'} ` +
      `favicon=${settings?.favicon ? 'yes' : 'no'}`,
  );
  if (settings) await writeDoc(outDir, paths.settings(orgId, siteId, versionId), settings);
  else
    console.warn(
      `[deploy] settings MISSING for version=${versionId} — site will render with ` +
        `defaultSiteSettings (lang=en, Inter, no favicon, "New Site")`,
    );

  // Partials
  const partials = await vstore.partials(orgId, siteId, versionId);
  for (const p of partials) await writeDoc(outDir, `${paths.partials(orgId, siteId, versionId)}/${p.id}`, p);

  // Pages — only published + unlisted are read at build time anyway
  const pageDocs = await vstore.pages(orgId, siteId, versionId);
  for (const p of pageDocs) {
    if (p.status === 'draft' || p.status === 'review') continue;
    await writeDoc(outDir, `${paths.pages(orgId, siteId, versionId)}/${p.id}`, p);
  }

  // Redirects
  const redirects = await vstore.redirects(orgId, siteId, versionId);
  for (const r of redirects) {
    await writeDoc(outDir, `${paths.redirects(orgId, siteId, versionId)}/${r.id}`, r);
  }

  // Block types + page templates. Both feed the block renderer at build
  // time. We include drafts on templates too — the renderer filters by
  // status, but having the doc materialised means a quick republish after
  // setting status=published works without re-deploying first.
  // Chain-fallback (vstore) so a BRANCH build inherits the base library /
  // templates it didn't override — raw store.listDocs would drop every
  // non-overridden block type / template, the same bug class as missing
  // settings on a branch deploy.
  const blockTypeDocs = await vstore.blockTypes(orgId, siteId, versionId);
  for (const bt of blockTypeDocs) {
    if (!bt.id) continue;
    await writeDoc(outDir, `${paths.blockTypes(orgId, siteId, versionId)}/${bt.id}`, bt as unknown as Record<string, unknown>);
  }
  const templateDocs = await vstore.pageTemplates(orgId, siteId, versionId);
  for (const t of templateDocs) {
    if (!t.id) continue;
    await writeDoc(outDir, `${paths.pageTemplates(orgId, siteId, versionId)}/${t.id}`, t as unknown as Record<string, unknown>);
  }

  // Collections + their items. The renderer reads both directly from the
  // store (getAllCollections / getCollectionItems) for listing blocks and
  // per-item route generation — so a deploy build that reads these fixtures
  // (rather than live Firestore) renders no collection content unless we
  // materialise them here. Chain-fallback (vstore) so a BRANCH inherits the
  // collections + items it didn't override, the same class as settings /
  // block types. Items are keyed under the collection's machine `name`,
  // matching how the renderer reads them. Drafts are skipped (the renderer
  // never routes or lists them) — mirrors the page handling above.
  const collectionDocs = await vstore.collections(orgId, siteId, versionId);
  for (const c of collectionDocs) {
    if (!c.name) continue;
    await writeDoc(outDir, paths.collection(orgId, siteId, c.name, versionId), c as unknown as Record<string, unknown>);
    // Strip what the published site never reads: per-field provenance, and
    // any field the schema marks `rendered: false` (agent working state a
    // portal operator wants visible but the renderer has no business
    // binding). Keeps the snapshot — and therefore build time — proportional
    // to what actually renders, and stops `{{item._provenance.*}}` from being
    // a bindable template path.
    const hiddenFields = (c.fields ?? [])
      .filter((f) => (f as { rendered?: boolean }).rendered === false)
      .map((f) => f.name);
    const itemDocs = await vstore.collectionItems(orgId, siteId, versionId, c.name);
    for (const item of itemDocs) {
      if (!item.id || item.status === 'draft') continue;
      const doc = { ...(item as unknown as Record<string, unknown>) };
      delete doc._provenance;
      for (const f of hiddenFields) delete doc[f];
      await writeDoc(outDir, paths.collectionItem(orgId, siteId, c.name, item.id, versionId), doc);
    }
  }

  // Forms 2.0: forms ship to the build enriched with their embed info
  // (submit_url + signed token + pow difficulty) so core/form blocks can
  // render complete working markup without the build having any secrets.
  // FORMS_PUBLIC_URL (the dedicated tr-forms service) wins over the
  // portal's own URL when set.
  {
    const { formEmbedInfo } = await import('../forms-signing');
    const { POW_BITS } = await import('../forms-signing');
    const formDocs = await store.listDocs<Record<string, unknown>>(paths.forms(orgId, siteId));
    for (const f of formDocs) {
      const id = (f as { id?: string }).id;
      if (!id) continue;
      // Post-submit actions are server-only and may contain encrypted secrets.
      // The static renderer needs steps/styles/metadata, never action config.
      const buildForm = { ...f };
      delete buildForm.actions;
      // App-backed forms resolve through one shared helper that
      // render-preview uses too, so the editor can't show a different
      // endpoint than the build ships.
      const { resolveAppFormEndpoint } = await import('../apps/form-endpoint');
      const appEndpoint = resolveAppFormEndpoint(f as { target?: Form['target'] }, {
        siteId,
        portalUrl: (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, ''),
      });
      if (appEndpoint) {
        assertPublicSubmitUrl(appEndpoint.submit_url, `core module form ${id}`);
        await writeDoc(outDir, `${paths.forms(orgId, siteId)}/${id}`, { ...buildForm, ...appEndpoint });
        continue;
      }
      const embed = formEmbedInfo(orgId, siteId, id);
      assertPublicSubmitUrl(embed.submit_url, `form ${id}`);
      await writeDoc(outDir, `${paths.forms(orgId, siteId)}/${id}`, {
        ...buildForm,
        submit_url: embed.submit_url,
        submit_token: embed.submit_token,
        pow_bits: POW_BITS,
      });
    }
  }

  // Media docs — needed at build time so the site-template can resolve
  // CDN URLs to pre-generated variants (AVIF/WebP/srcset) and source
  // dimensions (width/height for CLS). Media lives per-site, not per-
  // version, so the path is version-independent.
  const mediaDocs = await store.listDocs<Record<string, unknown>>(
    paths.media(orgId, siteId),
  );
  for (const m of mediaDocs) {
    const id = (m as { id?: string }).id;
    if (!id) continue;
    await writeDoc(outDir, `${paths.media(orgId, siteId)}/${id}`, m);
  }
}

function assertPublicSubmitUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Cannot deploy ${label}: configure FORMS_PUBLIC_URL or PORTAL_PUBLIC_URL with an absolute URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Cannot deploy ${label}: the public submit endpoint must use HTTPS`);
  }
}

async function writeDoc(outDir: string, docPath: string, data: Record<string, any>) {
  // Strip the id from the data; it's encoded in the filename.
  const { id: _ignored, ...rest } = data;
  void _ignored;
  const filePath = path.join(outDir, `${docPath}.json`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(rest, null, 2));
}

interface SpawnArgs {
  cwd: string;
  outDir: string;
  env: Record<string, string>;
}

async function spawnAstroBuild(args: SpawnArgs): Promise<void> {
  // Defensive: pre-create the outDir so even a no-op astro build leaves
  // the directory in place for the _redirects/_headers writes that follow.
  await fs.promises.mkdir(args.outDir, { recursive: true });

  // We previously spawned node directly against astro/dist/cli/index.js.
  // That works locally but on Cloud Run the same invocation exited 0 with
  // zero stdout/stderr and no dist output — most likely Astro 5's CLI
  // entrypoint detects when it isn't invoked as a CLI binary and silently
  // no-ops. Going through `npm run build` uses the package's bin wiring
  // and matches what `npm test` runs in CI.
  console.log(`[deploy] spawnAstroBuild cwd=${args.cwd} outDir=${args.outDir}`);
  console.log(`[deploy] env: ${Object.keys(args.env).join(', ')}`);

  const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build', '--', '--outDir', args.outDir], {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      stdio: 'pipe',
    });
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);

    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      // Always surface astro's output for debugging — both branches.
      // Truncated to last 4KB each so a chatty build doesn't blow the log.
      const tailStdout = stdout.slice(-4000);
      const tailStderr = stderr.slice(-4000);
      if (timedOut) {
        reject(new Error(`astro build timed out after ${BUILD_TIMEOUT_MS / 1000}s\nstdout:\n${tailStdout}\nstderr:\n${tailStderr}`));
      } else if (code === 0) {
        console.log(`[deploy] astro build exit=0\nstdout (last 1000):\n${stdout.slice(-1000)}\nstderr (last 500):\n${stderr.slice(-500)}`);
        resolve();
      } else {
        reject(new Error(`astro build exited with code ${code}\nstdout:\n${tailStdout}\nstderr:\n${tailStderr}`));
      }
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

/**
 * Build the `_redirects` file body. Pure function so the cross-host
 * canonical line is testable without spawning astro.
 *
 * Two sources, in this order — Cloudflare Pages processes the file
 * top-down and stops at the first match:
 *
 *   (a) Apex/www canonicalisation. When the site has registered an
 *       apex/www pair via the domain lifecycle, we emit a 301 from the
 *       alias variant → canonical preserving the path. The `!` marks
 *       it as "force" so a path-level user redirect can't accidentally
 *       shadow the host-level rule. This is the fix for the
 *       autopilot.se "522 on apex" failure mode — the Pages project is
 *       registered for both variants, so this file is what tells Pages
 *       which one wins.
 *
 *   (b) User-defined redirects from the redirects collection. Emitted
 *       as `<from> <to> <status>` per CF Pages spec.
 *
 * Returns null when there's nothing to emit (no pair + no user
 * redirects) so the caller can skip the write.
 */
export function buildRedirectsFile(
  site: Site | null | undefined,
  redirects: Array<Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>>,
  trailingSlashPolicy: TrailingSlashPolicy = 'ignore',
): string | null {
  const lines: string[] = [];
  if (site?.domain && site.domain_alias) {
    lines.push(`https://${site.domain_alias}/* https://${site.domain}/:splat 301!`);
  }
  // Order is behaviour, not cosmetics: Cloudflare stops at the first
  // matching line, so a literal rule must precede a pattern that also
  // matches it, and `/blogg/recept/*` must precede `/blogg/*`. Sorting here
  // (rather than trusting the collection's iteration order, which differs
  // between the Firestore and fixtures backends) is what makes the emitted
  // file deterministic and matches what analyzeCoverage predicts.
  for (const r of expandRedirectsForTrailingSlashPolicy(redirects, trailingSlashPolicy)) {
    lines.push(`${r.from_path} ${r.to_path} ${r.status_code}`);
  }
  if (lines.length === 0) return null;
  return lines.join('\n') + '\n';
}
