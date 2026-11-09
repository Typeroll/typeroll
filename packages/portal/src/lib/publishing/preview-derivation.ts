// Derived data for previews: the same derivation a publication runs, without
// publishing.
//
// A preview used to render derived repeaters empty, so an app's profiles,
// memberships, counts and filter datasets could only be reviewed on the live
// site. Here the preview freezes the version's content exactly as a
// publication would (consistent snapshot, public projection: published pages
// and public fields only, no working copies, no pending proposals), sends it
// to the same providers with the same signed request, and returns the same
// validated result. No separate copy of any fact is stored.
//
// Results are reused only for an identical input: the key is the digest of the
// frozen content and the public app configuration and releases. Changed
// content changes the key, so a reused result can never be older than the
// content it is shown with.

import { CORE_BLOCK_TYPES, type Site } from '@typeroll/shared';
import { paths } from '@typeroll/shared';
import { createHash } from 'node:crypto';
import { getStore } from '../datastore';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { resolvePublicationVersion } from './publication-version';
import { publicationRuntime } from './runtime-projection';
import { buildExtensionRuntimeSnapshot } from '../extensions/runtime-snapshot';
import { DerivationError, runBuildDerivations, stableDigest, type DerivationOutcome, type DerivationProvider } from './build-derivation';
import { derivationProvidersFor, publicationConfigDigest, publicationContentDigest } from './derivation-providers';

/** The app releases a derivation ran with, as the publication would resolve them. */
export interface DerivationApp {
  installation_id: string;
  extension_id: string;
  version: string;
}

/**
 * What a derivation consulted and produced, without the data itself.
 *
 * `content_revision` is the digest of the frozen public content. Two previews
 * (or a preview and a publication) with the same content revision, config
 * digest and app versions derive from identical input.
 */
export interface DerivationReceiptSummary {
  status: 'none' | 'succeeded' | 'failed';
  content_revision: string;
  config_digest: string;
  apps: DerivationApp[];
  /** sha256 of the dataset served at the derived data URL; null without data. */
  data_digest: string | null;
  receipts: DerivationOutcome['receipts'];
  cache_keys: Record<string, string>;
  skipped: DerivationOutcome['skipped'];
  /** Set when status is failed: the provider and its reason, never an empty result. */
  error?: { message: string; provider?: string };
  computed_at: string;
}

export interface PreviewDerivation extends DerivationReceiptSummary {
  /** Derived records by source id, as a build would freeze them. */
  derived: Record<string, Array<Record<string, unknown>>>;
  /** The exact bytes a build writes to /_typeroll/derived/<data_digest>.json. */
  data: string | null;
  reused: boolean;
}

/** The receipt a publication or dry run records, built from its own outcome. */
export function derivationReceipt(
  content_revision: string,
  config_digest: string,
  apps: DerivationApp[],
  outcome: DerivationOutcome,
  computed_at = new Date().toISOString(),
): DerivationReceiptSummary {
  const derived = Object.fromEntries(outcome.sources.map(source => [source.id, source.records]));
  const data = outcome.sources.length ? JSON.stringify(derived) : null;
  return {
    // Succeeded when any provider ran (an optional one may have been skipped); none without providers.
    status: Object.keys(outcome.cache_keys).length || outcome.skipped.length ? 'succeeded' : 'none',
    content_revision, config_digest, apps,
    data_digest: data ? createHash('sha256').update(data).digest('hex') : null,
    receipts: outcome.receipts, cache_keys: outcome.cache_keys, skipped: outcome.skipped, computed_at,
  };
}

/** Apps on a runtime snapshot that declared a derivation, in a stable order. */
export function derivationApps(providers: DerivationProvider[], runtime: { installations: Array<{ installation_id: string; extension_id: string; version: string }> }): DerivationApp[] {
  return providers
    .map(provider => runtime.installations.find(installation => installation.installation_id === provider.id))
    .filter((installation): installation is NonNullable<typeof installation> => Boolean(installation))
    .map(({ installation_id, extension_id, version }) => ({ installation_id, extension_id, version }))
    .sort((a, b) => (a.installation_id < b.installation_id ? -1 : 1));
}

// Per-isolate reuse. Bounded, and keyed by the full input, so a hit is always
// for identical content, configuration and releases.
const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<PreviewDerivation> }>();

/** For tests. */
export function clearPreviewDerivationCache() { cache.clear(); }

/**
 * Derive this version's data as its next publication would.
 *
 * Never throws for a provider failure: a preview must show that derivation
 * failed, with the reason, instead of rendering empty listings as if there
 * were no data. Infrastructure errors (the datastore) still throw.
 */
export async function previewDerivation(
  orgId: string, siteId: string, versionId: string,
  { contentRevision: wantRevision = true }: { contentRevision?: boolean } = {},
): Promise<PreviewDerivation> {
  const store = getStore();
  const failed = (error: DerivationError, revision: string, config: string, apps: DerivationApp[]): PreviewDerivation => ({
    status: 'failed', content_revision: revision, config_digest: config, apps, data_digest: null, receipts: [], cache_keys: {}, skipped: [],
    error: { message: error.message, ...(error.provider ? { provider: error.provider } : {}) },
    computed_at: new Date().toISOString(), derived: {}, data: null, reused: false,
  });
  const none = (): PreviewDerivation => ({ status: 'none', content_revision: '', config_digest: '', apps: [], data_digest: null, receipts: [], cache_keys: {}, skipped: [],
    computed_at: new Date().toISOString(), derived: {}, data: null, reused: false });
  // The apps alone decide whether there is anything to derive, so a page view
  // does not depend on the rest of the publication runtime (forms, analytics).
  const extensions = await buildExtensionRuntimeSnapshot(orgId, siteId, { reconcileBlocks: false, strict: true, versionId });
  let providers: DerivationProvider[];
  try {
    providers = await derivationProvidersFor(orgId, siteId, extensions);
  } catch (error) {
    if (!(error instanceof DerivationError)) throw error;
    return failed(error, '', '', []);
  }
  // A page view on a site without deriving apps needs no frozen content at all.
  if (!providers.length && !wantRevision) return none();
  let runtime: Awaited<ReturnType<typeof publicationRuntime>>;
  try {
    runtime = await publicationRuntime(orgId, siteId, versionId);
  } catch (error) {
    // A publication would refuse this runtime too (for example a form endpoint
    // that is not public HTTPS). Without deriving apps the preview is unaffected.
    if (!providers.length) return none();
    const message = error instanceof Error ? error.message : String(error);
    return failed(new DerivationError(`The publication runtime cannot be resolved: ${message}`, 'publication'), '', '', derivationApps(providers, extensions));
  }
  const configDigest = publicationConfigDigest(runtime);
  const [resolved, site] = await Promise.all([
    resolvePublicationVersion(orgId, siteId, versionId),
    store.getDoc<Site>(paths.site(orgId, siteId)),
  ]);
  // The projection a publication makes: published pages and public fields only.
  // The site URL does not reach pages, so the content digest equals the publication's.
  let frozen: Record<string, any>;
  try {
    frozen = projectStaticPublication(
    { ...resolved, site: { ...site, domain: site?.domain || 'preview.typeroll.invalid' }, media: [], forms: runtime.forms, extensions: runtime.extensions.installations, publicRuntime: runtime },
    { siteUrl: 'https://preview.typeroll.invalid', coreCommit: /^[a-f0-9]{40}$/.test(process.env.TYPEROLL_SOURCE_SHA ?? '') ? process.env.TYPEROLL_SOURCE_SHA! : '0'.repeat(40), publishedAt: new Date(0).toISOString(), noindex: true, coreBlockTypes: CORE_BLOCK_TYPES },
    );
  } catch (error) {
    // Content a publication would refuse to freeze cannot be derived either: say why.
    return failed(new DerivationError(`Content cannot be frozen for publication: ${error instanceof Error ? error.message : String(error)}`, 'publication'), '', configDigest, derivationApps(providers, runtime.extensions));
  }
  const content = { version_id: resolved.versionId, pages: frozen.pages, content_types: frozen.contentTypes };
  const contentRevision = publicationContentDigest(content);
  const apps = derivationApps(providers, runtime.extensions);
  const key = stableDigest({ org: orgId, site: siteId, version: resolved.versionId, content: contentRevision, config: configDigest, apps });

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...(await hit.value), reused: true };

  const value = (async (): Promise<PreviewDerivation> => {
    try {
      const outcome = await runBuildDerivations(
        { org_id: orgId, site_id: siteId, version_id: resolved.versionId, content_digest: contentRevision, content, config_digest: configDigest, provider_version: '' },
        providers,
      );
      const receipt = derivationReceipt(contentRevision, configDigest, apps, outcome);
      const derived = Object.fromEntries(outcome.sources.map(source => [source.id, source.records]));
      return { ...receipt, derived, data: outcome.sources.length ? JSON.stringify(derived) : null, reused: false };
    } catch (error) {
      if (!(error instanceof DerivationError)) throw error;
      return failed(error, contentRevision, configDigest, apps);
    }
  })();
  // Failures are not reused: the next preview retries the provider.
  cache.set(key, { at: Date.now(), value });
  value.then(result => { if (result.status === 'failed') cache.delete(key); }, () => cache.delete(key));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

/** The receipt without the data, as an API returns it. */
export function receiptOf(derivation: DerivationReceiptSummary & Partial<PreviewDerivation>): DerivationReceiptSummary {
  const { derived: _derived, data: _data, reused: _reused, ...receipt } = derivation as PreviewDerivation;
  return receipt;
}
