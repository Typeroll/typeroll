// Publication job for hosted sites (`publishing_mode: hosted`).
//
// A sibling of customer-runner.ts, not a branch inside it: there is no Git
// repository, Pages project, Hosting Group or DNS to manage: the bound
// hosting service (site-hosting.ts) serves the site. The phases, each
// a bounded queue attempt that checkpoints on the job:
//
//   1. freeze   the publication snapshot, as a customer publication does
//   2. build    on the organization's build engine through the existing engine
//               protocol; the engine returns the whole site instead of
//               uploading it to Pages (BuildInput.direct_upload: false)
//   3. deploy   hand the artifact to the hosting service as the live publication
//   4. verify   once: the site's serving host must answer with this
//               publication's marker. A few bounded probes inside the job
//               allow for propagation; if it never answers, the previous live
//               upload is activated again and the job fails.
//
// The publication goes live and is verified right after, as a Pages main
// publication is.
// Nothing is scheduled after the job ends: no background re-checks.
//
// Rollback and version restore make an earlier recorded publication live
// again (`restoreHostedPublication`).

import { randomUUID } from 'node:crypto';
import { CORE_BLOCK_TYPES, MAIN_VERSION_ID, paths, type DeployJob, type Site } from '@typeroll/shared';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { getStore } from '../datastore';
import { probePublication } from '../deploy/availability';
import type { DeployRunOutcome, EnqueueArgs } from '../deploy/queue';
import { prepareEngineForBuild, type EngineUpdateRecord } from '../builds/auto-update';
import { completedBuild, enqueueBuild } from '../builds/jobs';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from '../builds/queue';
import { selectedBuildProvider } from '../builds/selection';
import { readEngineConfiguration, type BuildProvider } from '../builds/state';
import { schedulePublication, waitForBuild, waitForPublicationCondition } from '../scheduling/continuation';
import { DerivationError, runBuildDerivations } from './build-derivation';
import { ConnectionError } from './connections';
import { derivationProvidersFor, publicationConfigDigest, publicationContentDigest } from './derivation-providers';
import { getOrganizationDomains, getSiteDomains } from './domain-config';
import { assertDryRunValidation, publicationLanguageWarnings } from './dry-run-validation';
import { redactFailureText } from './http';
import { compareImpact } from './impact';
import { capturePublicationImpact } from './impact-preview';
import { collapseMediaHostChains, moveWebsiteMediaToMediaHost, publicationMediaManifest, replacedMediaRedirects, retainDistinctMediaManifests } from './media-manifest';
import { digest } from './providers.mjs';
import { recordPublishedMedia } from './published-media';
import { readSnapshot, saveSnapshot, type SnapshotReference } from './publication-snapshot';
import { resolvePublicationVersion } from './publication-version';
import { publicationSiteFieldWarnings } from './content-preflight';
import { assertPublishingReady } from './readiness';
import { publicationRuntime } from './runtime-projection';
import { recordPublishingOrigin } from './runtime-origins';
import { publicationSourceTree } from './source-tree';
import { freezeThemeFonts } from './theme-font-freeze';
import { artifactFiles, ensureHostedPlatformHost, hostedDomains, hostedServingHost, hostedWebsiteHost, hostingSiteRef, HOSTED_MODE, isHostedSite,
  isTemporaryHostingFailure, siteHosting, siteHostingAvailable, SITE_HOSTING_UNAVAILABLE, type ArtifactFiles } from './site-hosting';

/**
 * The frozen publication of a hosted job. Stored as the job's
 * `git_publication`, the field build progress, failure reporting and build
 * completion wakeups already read; `provider` tells it apart.
 */
export interface HostedPublication extends SnapshotReference {
  provider: typeof HOSTED_MODE;
  publication_id: string;
  content_cutoff: string;
  /** Canonical host the snapshot was built for. */
  website_host: string;
  /** The build protocol's 40-hex source identity. Hosted publications have no Git commit; it is derived from the publication id. */
  commit: string;
  branch: 'main';
  snapshot_job_id: string;
  build_provider?: BuildProvider;
  build_engine_revision?: string;
  build_task_key?: string | null;
  /** The live publication before this one replaced it: what a failed verification restores. Recorded before the upload. */
  rollback_to?: string | null;
  deployed?: { digest: string; uploaded_files: number; deployed_at: string };
}

export interface HostedVerification { host: string | null; attempts: number; ready: boolean; checked_at: string }

type HostedJob = DeployJob & {
  git_publication?: HostedPublication; hosted_verification?: HostedVerification; engine_update?: EngineUpdateRecord;
  coordinator_retries?: number; failure?: { code: string; stage?: string } | null; completion_signals?: Record<string, boolean>;
};
interface Target { job_id: string | null; lease_id: string | null; lease_until: number; last_publication?: HostedPublication | Record<string, any> }

/** Probes of the serving host before a publication counts as not served (about two minutes with the poll backoff). */
export const HOSTED_VERIFICATION_ATTEMPTS = 8;
const MARKER = '/.well-known/typeroll/publication.json';
const LEASE_MS = 300_000;

export function hostedSourceCommit(publicationId: string): string {
  return digest(`hosted\0${publicationId}`).slice(0, 40);
}

/** Rate limits and outages of the hosting service are retried a few times from the checkpoint. */
const temporaryFailure = isTemporaryHostingFailure;

/** One bounded queue attempt of a hosted publication. */
export async function executeHostedPublication(args: EnqueueArgs): Promise<DeployRunOutcome> {
  const store = getStore();
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  const job = await store.getDoc<HostedJob>(jobPath);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return 'ran';
  if (!siteHostingAvailable()) {
    await store.compareAndUpdateDoc<HostedJob>(jobPath, current => ['queued', 'running'].includes(String(current.status)), {
      status: 'failed', phase: 'failed', finished_at: new Date().toISOString(), error: SITE_HOSTING_UNAVAILABLE.message, failure: { code: SITE_HOSTING_UNAVAILABLE.code },
    }).catch(() => { /* the job document is gone */ });
    return 'ran';
  }

  // Per-site serialization: the same publication target (and lease) as customer publishing.
  const targetPath = `${paths.site(args.orgId, args.siteId)}/publishing_targets/${args.versionId}`;
  const lease = randomUUID();
  await store.createDocIfMissing(targetPath, { job_id: null, lease_id: null, lease_until: 0 });
  const previousOwner = await store.getDoc<Target>(targetPath);
  if (previousOwner?.job_id && previousOwner.job_id !== args.jobId && previousOwner.lease_until < Date.now()) {
    const ownerJob = await store.getDoc<DeployJob>(paths.deploy(args.orgId, args.siteId, previousOwner.job_id));
    if (!ownerJob || ['succeeded', 'failed'].includes(ownerJob.status)) await store.compareAndUpdateDoc<Target>(targetPath,
      target => target.job_id === previousOwner.job_id && target.lease_until < Date.now(), { job_id: null });
  }
  const acquired = await store.compareAndUpdateDoc<Target>(targetPath,
    target => (!target.job_id || target.job_id === args.jobId) && target.lease_until < Date.now(),
    { job_id: args.jobId, lease_id: lease, lease_until: Date.now() + LEASE_MS });
  if (!acquired) {
    const owner = await store.getDoc<Target>(targetPath);
    if (owner?.job_id && owner.job_id !== args.jobId) await store.updateDoc(jobPath, { waiting_for_job_id: owner.job_id, phase: 'waiting for the previous publication' });
    return 'deferred';
  }
  if (job.waiting_for_job_id) await store.updateDoc(jobPath, { waiting_for_job_id: null });
  let leaseLost = false;
  let renewal: Promise<void> = Promise.resolve();
  const assertLease = () => {
    renewal = renewal.then(async () => {
      if (leaseLost || !await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + LEASE_MS })) {
        leaseLost = true;
        throw new ConnectionError('Publication ownership changed; continuing from the saved checkpoint.', 409, 'publication_lease_lost');
      }
    });
    return renewal;
  };
  // Keeps ownership during a long upload; never waits for a remote build.
  const heartbeat = setInterval(() => { void assertLease().catch(() => { leaseLost = true; }); }, 30_000);
  (heartbeat as { unref?: () => void }).unref?.();
  const checkpoint = async (phase: string, outcome: DeployRunOutcome = 'continue'): Promise<DeployRunOutcome> => {
    await assertLease();
    await store.updateDoc(jobPath, { phase, coordinator_retries: 0 });
    if (outcome === 'continue') await schedulePublication(jobPath, 'checkpoint');
    return outcome;
  };
  let terminal = false;
  try {
    if (args.versionId !== MAIN_VERSION_ID || args.environment === 'staging') {
      throw new ConnectionError('A hosted site publishes its main version to production only.', 409, 'hosting_version_unsupported');
    }
    const site = await store.getDoc<Site>(paths.site(args.orgId, args.siteId));
    if (!isHostedSite(site)) throw new ConnectionError('This site is no longer a hosted site. Start a new deployment.', 409, 'publishing_mode_changed');
    const provider = siteHosting();
    const ref = await hostingSiteRef(args.orgId, args.siteId);
    let publication = job.git_publication;

    // 1. Freeze.
    if (!publication) {
      await assertPublishingReady(args.orgId, args.siteId, args.versionId, { checkBuild: false });
      await store.updateDoc(jobPath, { status: 'running', phase: 'freezing source' });
      const platformHost = await ensureHostedPlatformHost(args.orgId, args.siteId, site!.slug ?? args.siteId);
      const host = hostedWebsiteHost(await hostedDomains(args.orgId, args.siteId), site) ?? platformHost;
      const contentCutoff = new Date().toISOString();
      const priorPublication = acquired.last_publication as HostedPublication | undefined;
      const prior = priorPublication?.snapshot_job_id
        ? await readSnapshot({ ...args, jobId: priorPublication.snapshot_job_id }, priorPublication).catch(() => null) : null;
      const resolved = await resolvePublicationVersion(args.orgId, args.siteId, args.versionId);
      const publicRuntime = await publicationRuntime(args.orgId, args.siteId, args.versionId);
      // Indexing before launch is prevented by the hosting service (noindex on
      // every hostname that is not indexable), so launching needs no rebuild.
      let frozen: Record<string, any> = projectStaticPublication({ ...resolved, site: { ...site, domain: host }, media: [], forms: publicRuntime.forms, extensions: publicRuntime.extensions.installations, publicRuntime }, {
        siteUrl: `https://${host}`, coreCommit: process.env.TYPEROLL_SOURCE_SHA ?? '', publishedAt: contentCutoff, noindex: false, coreBlockTypes: CORE_BLOCK_TYPES,
      });
      const content = { version_id: resolved.versionId, pages: frozen.pages, content_types: frozen.contentTypes };
      const derivation = await runBuildDerivations({
        org_id: args.orgId, site_id: args.siteId, version_id: resolved.versionId,
        content_digest: publicationContentDigest(content), content, config_digest: publicationConfigDigest(publicRuntime), provider_version: '',
      }, await derivationProvidersFor(args.orgId, args.siteId, publicRuntime.extensions));
      frozen.authored_noindex = resolved.settings?.sitewide_noindex === true;
      if (derivation.sources.length > 0) frozen.derived = Object.fromEntries(derivation.sources.map(source => [source.id, source.records]));
      if (derivation.receipts.length > 0 || derivation.skipped.length > 0) {
        frozen.derivation = { receipts: derivation.receipts, cache_keys: derivation.cache_keys, ...(derivation.skipped.length > 0 ? { skipped: derivation.skipped } : {}) };
      }
      const [domains, organization] = await Promise.all([getSiteDomains(args.orgId, args.siteId), getOrganizationDomains(args.orgId)]);
      const mapped = await publicationMediaManifest(args.orgId, args.siteId, frozen, host, undefined, { deferReferences: true, domains, dryRun: args.dryRun === true });
      // Images travel with the site; an organization media host lives in a Cloudflare account hosted sites do not have.
      if (mapped.manifest && mapped.manifest.delivery !== 'static') {
        throw new ConnectionError('Images of a hosted site are published with the site. Remove the organization media host in Publishing, then publish again.', 409, 'hosted_media_host_unsupported');
      }
      const warnings = [...mapped.warnings, ...publicationLanguageWarnings(frozen), ...publicationSiteFieldWarnings(frozen)];
      if (warnings.length) await store.updateDoc(jobPath, { warnings });
      const impactSnapshot = await capturePublicationImpact(frozen, args.orgId, args.siteId, domains, organization, mapped.sourceMedia);
      // Absolute links to earlier addresses of the site are frozen as links to its canonical host.
      const previousOrigins = [`https://${platformHost}`, site?.domain ? `https://${site.domain}` : '', prior?.site_url ?? '', ...(prior?.reference_mapping?.website_origins ?? [])].filter(Boolean);
      frozen = { ...mapped.content, reference_mapping: { format: 1, media: (mapped.content as any).reference_mapping?.media ?? [], website_origins: [...new Set(previousOrigins)] } };
      frozen = { ...frozen, site_url: `https://${host}`, site: { ...frozen.site, domain: host }, media: mapped.media, media_manifest: mapped.manifest, source_impact_snapshot: impactSnapshot };
      await store.updateDoc(jobPath, { build_impact: compareImpact(prior?.source_impact_snapshot, impactSnapshot) });
      const retained = [...(prior?.retained_media_manifests ?? []), ...((prior?.media_manifest?.delivery === 'static' || prior?.media_manifest?.media_host === prior?.media_manifest?.website_host) && prior?.media_manifest ? [prior.media_manifest] : [])];
      frozen.media_replacement_redirects = replacedMediaRedirects(retained, frozen.media_manifest, frozen.redirects, prior?.media_replacement_redirects);
      frozen.redirects = [...frozen.redirects ?? [], ...frozen.media_replacement_redirects.filter((rule: any) => !frozen.redirects?.some((existing: any) => existing.from_path === rule.from_path))];
      const movedMedia = moveWebsiteMediaToMediaHost(retainDistinctMediaManifests(retained, frozen.media_manifest), frozen.media_manifest);
      frozen.retained_media_manifests = movedMedia.retained;
      frozen.media_host_redirects = movedMedia.redirects.filter(rule => !frozen.redirects?.some((existing: any) => existing.from_path === rule.from_path));
      frozen.redirects = [...collapseMediaHostChains(frozen.redirects ?? [], frozen.media_host_redirects, host), ...frozen.media_host_redirects.map(({ media_path_prefix: _prefix, ...rule }: any) => rule)];
      // Earlier addresses are redirected by the hosting service, not by the site.
      frozen.previous_website_hosts = [];
      const themeFonts = await freezeThemeFonts(frozen.settings?.fonts, prior?.theme_fonts);
      if (themeFonts) frozen.theme_fonts = themeFonts; else delete frozen.theme_fonts;
      frozen.publication_id = digest(JSON.stringify({ ...frozen, published_at: undefined, publication_id: undefined }));
      if (args.dryRun) {
        await publicationSourceTree(frozen);
        assertDryRunValidation(frozen.pages ?? []);
        await store.updateDoc(jobPath, { status: 'succeeded', phase: 'source verified (dry-run, nothing deployed)', dry_run: true, finished_at: contentCutoff });
        terminal = true; return 'ran';
      }
      if (priorPublication?.publication_id === frozen.publication_id && (await provider.deployment(ref)).live?.publication_id === frozen.publication_id) {
        const serving = hostedServingHost(await hostedDomains(args.orgId, args.siteId));
        if (serving && await probePublication(`https://${serving}`, MARKER, frozen.publication_id)) {
          await store.updateDoc(jobPath, { status: 'succeeded', phase: 'unchanged', finished_at: contentCutoff, deploy_url: `https://${serving}` });
          terminal = true; return 'ran';
        }
      }
      const selected = await selectedBuildProvider(args.orgId);
      const engine = await readEngineConfiguration(args.orgId, selected);
      // An engine update in progress is awaited before the build, not refused.
      const usable = engine?.status === 'ready' || (!!engine?.previous && (engine.status === 'preparing' || engine.status === 'qualifying'));
      if (!engine || !usable) throw new ConnectionError('Finish build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
      publication = { provider: HOSTED_MODE, publication_id: frozen.publication_id, content_cutoff: contentCutoff, website_host: host,
        commit: hostedSourceCommit(frozen.publication_id), branch: 'main', snapshot_job_id: args.jobId, ...await saveSnapshot(args, frozen),
        build_provider: engine.provider ?? 'cloudflare', build_engine_revision: engine.revision };
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication, execution_backend: publication.build_provider === 'github' ? 'organization_github' : 'organization_cloudflare' });
      return await checkpoint('source frozen');
    }

    // 2. Build.
    if (!publication.build_task_key) {
      const current = await store.getDoc<HostedJob>(jobPath);
      const step = await prepareEngineForBuild(args.orgId, publication.build_provider ?? 'cloudflare', current?.engine_update);
      if (step.state === 'waiting') {
        await assertLease();
        await store.updateDoc(jobPath, { engine_update: step.record, phase: step.phase });
        return await waitForPublicationCondition(jobPath, 'build_engine_update');
      }
      const updates: Record<string, unknown> = {};
      if (step.record) updates.engine_update = step.record;
      if (step.warning) updates.warnings = [...((current as any)?.warnings ?? []), step.warning];
      if (step.engine.revision !== publication.build_engine_revision) publication = updates.git_publication = { ...publication, build_engine_revision: step.engine.revision };
      if (Object.keys(updates).length) { await assertLease(); await store.updateDoc(jobPath, updates); }
      const engine = await readEngineConfiguration(args.orgId, publication.build_provider ?? 'cloudflare');
      if (!engine || engine.status !== 'ready' || engine.revision !== publication.build_engine_revision) throw new ConnectionError('The shared build engine changed. Retry this publication.', 409, 'build_engine_changed');
      if (!engine.static_verification) throw new ConnectionError('Update the build engine in Publishing → Builds before publishing.', 409, 'build_engine_update_required');
      const source = await publicationSourceTree(await readSnapshot(args, publication));
      const queued = await enqueueBuild(engine, { org_id: args.orgId, site_id: args.siteId, version_id: args.versionId, job_id: args.jobId,
        publication_id: publication.publication_id, commit: publication.commit, branch: 'main' }, source, 'publication',
        { requeueFailed: current?.engine_update?.reason === 'known_failure', directUpload: false });
      publication = { ...publication, build_task_key: queued.key };
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication });
      await checkpoint(publication.build_provider === 'github' ? 'building on GitHub Actions' : 'building on Cloudflare', 'waiting');
      return await waitForBuild(jobPath, args.orgId, queued.key);
    }

    // 3. Deploy the artifact as the live upload.
    if (!publication.deployed) {
      const result = await completedBuild(args.orgId, publication.build_task_key);
      if (!result) {
        await store.updateDoc(jobPath, { phase: publication.build_provider === 'github' ? 'building on GitHub Actions' : 'building on Cloudflare' });
        return await waitForBuild(jobPath, args.orgId, publication.build_task_key);
      }
      if (result.direct) throw new ConnectionError('The build engine uploaded this site to Cloudflare Pages instead of returning it. Update the build engine in Publishing → Builds, then retry the publication.', 409, 'build_engine_update_required');
      if (publication.rollback_to === undefined) {
        const live = (await provider.deployment(ref)).live?.publication_id ?? null;
        publication = { ...publication, rollback_to: live === publication.publication_id ? null : live };
        await assertLease();
        await store.updateDoc(jobPath, { git_publication: publication });
      }
      await store.updateDoc(jobPath, { phase: 'uploading the site',
        ...(result.task.seo_report ? { seo_report: result.task.seo_report } : {}), ...(result.task.render_report ? { render_report: result.task.render_report } : {}) });
      const frozen = await readSnapshot(args, publication);
      await assertLease();
      const deployed = await provider.publish({ site: ref, publication_id: publication.publication_id,
        files: artifactFiles(result.files), trailing_slash: frozen.settings?.trailing_slash });
      publication = { ...publication, deployed: { digest: deployed.digest, uploaded_files: deployed.uploaded_files, deployed_at: new Date().toISOString() } };
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication, phase: 'verifying the published site' });
    }

    // 4. Verify once on the serving host.
    const state = await hostedDomains(args.orgId, args.siteId);
    const host = hostedServingHost(state);
    const ready = host ? await probePublication(`https://${host}`, MARKER, publication.publication_id) : false;
    const attempts = ((await store.getDoc<HostedJob>(jobPath))?.hosted_verification?.attempts ?? 0) + 1;
    const verification: HostedVerification = { host, attempts, ready, checked_at: new Date().toISOString() };
    if (!ready) {
      if (attempts < HOSTED_VERIFICATION_ATTEMPTS) {
        await assertLease();
        await store.updateDoc(jobPath, { hosted_verification: verification, phase: 'verifying the published site',
          verification_message: `https://${host} does not serve this publication yet. Verification continues automatically.` });
        return await waitForPublicationCondition(jobPath, 'verifying the published site');
      }
      let restored = ' There was no earlier publication to restore.';
      if (publication.rollback_to) {
        try { await provider.activate({ site: ref, publication_id: publication.rollback_to }); restored = ' The previous publication was restored.'; }
        catch (error) { restored = ` Restoring the previous publication failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
      await store.updateDoc(jobPath, { hosted_verification: verification });
      throw new ConnectionError(`https://${host} did not serve this publication after it was deployed.${restored}`, 502, 'hosted_verification_failed', { hosted_verification: verification });
    }
    const finished = new Date().toISOString();
    const frozen = await readSnapshot(args, publication);
    await assertLease();
    await store.updateDoc(paths.version(args.orgId, args.siteId, args.versionId), { last_deployed_at: finished, last_deployed_content_at: publication.content_cutoff, deploy_url: `https://${host}` });
    for (const origin of new Set([host!, publication.website_host, state?.platform_host].filter((value): value is string => !!value))) {
      await recordPublishingOrigin(args.orgId, args.siteId, `https://${origin}`);
    }
    await recordPublishedMedia(args.orgId, args.siteId, frozen.media_manifest?.entries ?? [], { main: true });
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
    await store.updateDoc(jobPath, { status: 'succeeded', phase: 'live', deploy_url: `https://${host}`, verification_message: null, hosted_verification: verification, finished_at: finished });
    terminal = true;
    return 'ran';
  } catch (error) {
    const target = await store.getDoc<Target>(targetPath);
    if (leaseLost || target?.lease_id !== lease || target.lease_until <= Date.now()) return 'deferred';
    const failedJob = await store.getDoc<HostedJob>(jobPath);
    if (temporaryFailure(error) && (failedJob?.coordinator_retries ?? 0) < 5) {
      await assertLease();
      await store.updateDoc(jobPath, { coordinator_retries: (failedJob?.coordinator_retries ?? 0) + 1 });
      return await waitForPublicationCondition(jobPath, failedJob?.phase ?? 'provider');
    }
    const key = failedJob?.git_publication?.build_task_key;
    if (key) {
      const failedTask = await store.getDoc<BuildTask>(`${buildTasksPath(args.orgId)}/${key}`);
      if (failedTask?.seo_report) await store.updateDoc(jobPath, { seo_report: failedTask.seo_report });
      if (!failedJob?.git_publication?.deployed) await new OrganizationBuildQueue().cancel(args.orgId, key);
    }
    const failure = { stage: failedJob?.phase ?? 'preparing the publication',
      code: error instanceof DerivationError ? 'publication_derivation_failed' : error instanceof ConnectionError ? error.code ?? 'hosted_publication_failed' : 'publication_internal_error',
      ...(error instanceof DerivationError ? { provider: error.provider } : {}),
      ...(error instanceof ConnectionError && error.details?.build_diagnostic ? { diagnostic: error.details.build_diagnostic } : {}),
      ...(error instanceof ConnectionError && error.details?.cloudflare_errors ? { provider: 'Cloudflare', provider_operation: error.details.operation, http_status: error.details.http_status } : {}) };
    const internal = failure.code === 'publication_internal_error' && error instanceof Error
      ? { error_name: error.name, error_message: redactFailureText(error.message) } : {};
    console.error(JSON.stringify({ event: 'hosted_publication_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId, ...failure, ...internal }));
    const message = error instanceof DerivationError ? `An app could not prepare publication data (${error.provider}). ${error.message} The live site has not changed.`
      : error instanceof ConnectionError ? error.message
      : `Publishing stopped during ${failure.stage}. Retry the deployment. If it fails again, contact support with deployment ${args.jobId}.`;
    await store.updateDoc(jobPath, { status: 'failed', phase: 'failed', finished_at: new Date().toISOString(), error: message, failure });
    terminal = true;
    return 'ran';
  } finally {
    clearInterval(heartbeat);
    await renewal.catch(() => {});
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease,
      { lease_id: null, lease_until: 0, ...(terminal ? { job_id: null } : {}) });
    if (terminal) {
      const { wakePendingSite } = await import('../scheduling/worker');
      await wakePendingSite(args.orgId, args.siteId);
    }
  }
}

/**
 * Make an earlier hosted publication live again (rollback, version restore).
 * Without `publicationId` the previous distinct live publication is restored.
 * Holds the site's publication lease, so it never races a publication. The
 * artifact is passed along while its build is still stored, so files the
 * service no longer keeps can be sent again; otherwise the service refuses
 * the switch and the current site stays.
 * The result is recorded as a deploy job, verified once on the serving host.
 */
export async function restoreHostedPublication(orgId: string, siteId: string, input: { publicationId?: string; actor?: string } = {}) {
  if (!siteHostingAvailable()) throw new ConnectionError(SITE_HOSTING_UNAVAILABLE.message, 404, SITE_HOSTING_UNAVAILABLE.code);
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  if (!isHostedSite(site)) throw new ConnectionError('This site is not a hosted site.', 409, 'hosted_site_required');
  const provider = siteHosting();
  const ref = await hostingSiteRef(orgId, siteId);
  const targetPath = `${paths.site(orgId, siteId)}/publishing_targets/${MAIN_VERSION_ID}`;
  const jobId = randomUUID();
  const lease = randomUUID();
  await store.createDocIfMissing(targetPath, { job_id: null, lease_id: null, lease_until: 0 });
  const acquired = await store.compareAndUpdateDoc<Target>(targetPath, target => !target.job_id && target.lease_until < Date.now(),
    { job_id: jobId, lease_id: lease, lease_until: Date.now() + LEASE_MS });
  if (!acquired) throw new ConnectionError('A publication of this site is in progress. Restore it after the publication finishes.', 409, 'publication_in_progress');
  try {
    const deployment = await provider.deployment(ref);
    const live = deployment.live?.publication_id ?? null;
    const publicationId = input.publicationId
      ?? deployment.history.find(entry => entry.slot === 'live' && entry.publication_id !== live)?.publication_id;
    if (!publicationId) throw new ConnectionError('There is no earlier publication to restore.', 404, 'hosted_upload_not_found');
    if (!deployment.uploads.some(upload => upload.publication_id === publicationId)) throw new ConnectionError('This publication can no longer be restored.', 404, 'hosted_upload_not_found');
    const source = await publicationJob(orgId, siteId, publicationId);
    const artifact = source?.git_publication?.build_task_key ? await storedArtifact(orgId, source.git_publication.build_task_key) : undefined;
    const started = new Date().toISOString();
    await store.setDoc(paths.deploy(orgId, siteId, jobId), { version_id: MAIN_VERSION_ID, environment: 'production', status: 'running', phase: 'restoring an earlier publication',
      started_at: started, source: 'hosted_restore', triggered_by: input.actor ?? 'system', restored_publication_id: publicationId, replaced_publication_id: live });
    const result = await provider.activate({ site: ref, publication_id: publicationId, files: artifact });
    const host = hostedServingHost(await hostedDomains(orgId, siteId));
    const ready = host ? await probePublication(`https://${host}`, MARKER, publicationId) : false;
    const verification: HostedVerification = { host, attempts: 1, ready, checked_at: new Date().toISOString() };
    const finished = new Date().toISOString();
    if (source?.git_publication) {
      await store.updateDoc(paths.version(orgId, siteId, MAIN_VERSION_ID), { last_deployed_at: finished, last_deployed_content_at: source.git_publication.content_cutoff, ...(host ? { deploy_url: `https://${host}` } : {}) });
      await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: source.git_publication });
    }
    await store.updateDoc(paths.deploy(orgId, siteId, jobId), { status: 'succeeded', phase: 'live', finished_at: finished, hosted_verification: verification,
      ...(host ? { deploy_url: `https://${host}` } : {}),
      verification_message: ready ? null : `https://${host} did not answer with the restored publication yet. Check the site in a minute.` });
    return { job_id: jobId, publication_id: publicationId, replaced_publication_id: live, uploaded_files: result.uploaded_files, verified: ready };
  } catch (error) {
    if (await store.getDoc(paths.deploy(orgId, siteId, jobId))) {
      await store.updateDoc(paths.deploy(orgId, siteId, jobId), { status: 'failed', phase: 'failed', finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error), failure: { code: (error as ConnectionError)?.code ?? 'hosted_restore_failed' } });
    }
    throw error;
  } finally {
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { job_id: null, lease_id: null, lease_until: 0 });
  }
}

/** The succeeded hosted job that built a publication. */
async function publicationJob(orgId: string, siteId: string, publicationId: string): Promise<HostedJob | null> {
  const jobs = await getStore().listDocs<HostedJob>(paths.deploys(orgId, siteId));
  return jobs.filter(job => job.status === 'succeeded' && job.git_publication?.provider === HOSTED_MODE && job.git_publication.publication_id === publicationId)
    .sort((a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? '')))[0] ?? null;
}

/** The build's artifact while build storage still keeps it. */
async function storedArtifact(orgId: string, key: string): Promise<ArtifactFiles | undefined> {
  try {
    const result = await completedBuild(orgId, key);
    return result && !result.direct ? artifactFiles(result.files) : undefined;
  } catch { return undefined; }
}
