import { previousWebsiteHosts, preparePreviousHosts, retirePreviousHosts } from './previous-hosts';
import { refreshBuildFailure } from '../builds/failure-status';
import { journaledDomainProvider, armDomainCutover, recordDomainCutover, readDomainCutover, completeDomainCutover, rollbackDomainCutover } from './domain-cutover-journal';
import { domainPublicationRevision } from './domain-config';
import { assertVerificationRetry } from './verification-retry';
import { schedulePublication, waitForBuild, waitForPublicationCondition } from '../scheduling/continuation';
import { recordPublishedMedia } from './published-media';
import { ensureGithubMainBranch } from './providers.mjs';
import { createGithubRepository } from './github-user';
import { siteRepositoryName, generatedRepositoryDescription } from './site-repository';
import { verifyManagedProject } from './managed-migration';
import { capturePublicationImpact } from './impact-preview';
import { compareImpact } from './impact';
import { readSnapshot, saveSnapshot } from './publication-snapshot';
import { siteHostingGroup, lockSiteHostingGroup } from './hosting-groups';
import { hostingDns } from './hosting-dns';
import { purgePublicationHost } from './publication-cache';
import { applyApprovedCacheRefresh, recoverPublicationCache, type CacheRecovery } from './cache-recovery';
import { randomUUID } from 'node:crypto';
import { paths, CORE_BLOCK_TYPES, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { githubConfiguration } from './github-connection';
import { cloudflareClient } from './cloudflare-oauth';
import { githubInstallationClient, publishTree, pagesProjectBody, matchingDeployment, findPublicationDeployment, setPagesBuildMediaAccess, assertSuccessfulStaticDeployment, digest, ProviderError, githubFailureHint, ProviderTransportError } from './providers.mjs';
import { getSiteDomains, activePublicationDomains, hasPendingPublishedDomains, samePublicationHosts, sameRedirectHosts, getOrganizationDomains, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { prepareRedirectHosts, redirectApprovalBlocker, ensureApprovedRedirectRule, applyRedirectTraffic, verifyRedirectHost, type RedirectPreparation } from './redirect-hosts';
import { resolvePublicationVersion } from './publication-version';
import { assertPublishingReady } from './readiness';
import { publicationSourceTree } from './source-tree';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { probePublication } from '../deploy/availability';
import type { EnqueueArgs, DeployRunOutcome } from '../deploy/queue';
import { preparePagesDomain, applyPreparedTraffic, validationWindowAllowed } from './domain-provider';
import { assertDryRunValidation, publicationLanguageWarnings } from './dry-run-validation';
import { freezeThemeFonts } from './theme-font-freeze';
import { retainDistinctMediaManifests, replacedMediaRedirects, publicationMediaManifest } from './media-manifest';
import { customerBuildMediaAccess } from './r2-build-credentials';
import { publicationRuntime } from './runtime-projection';
import { DerivationError, runBuildDerivations } from './build-derivation';
import { derivationProvidersFor, publicationConfigDigest, publicationContentDigest } from './derivation-providers';
import { preparePublicMediaDomains } from './media-domain';
import { recordPublishingOrigin } from './runtime-origins';
import { retargetWebsite } from './publication-retarget';
import { recordCustomerCompute } from './compute-cost';
import { readEngineConfiguration, type BuildProvider } from '../builds/state';
import { selectedBuildProvider } from '../builds/selection';
import { enqueueBuild, completedBuild } from '../builds/jobs';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from '../builds/queue';
import { uploadStaticBuild, finalizeDirectUpload } from '../builds/upload';
import { claimCloudflareResource, generatedCloudflareNames } from './cloudflare-account-claims';
import { prepareStaticProject, saveStaticChecks, verifyStaticBatch, saveCustomerVerification, verifyCustomerCandidate, type CustomerVerification } from '../builds/publication';

interface GitPublication extends CustomerVerification {
  candidate_prepared_at?: string; candidate_verified_id?: string | null; deployment_receipt?: any; project_prepared?: boolean; website_preparation?: import('./domain-provider').DomainPreparation | null; media_preparation?: import('./domain-provider').DomainPreparation | null; public_media_prepared?: boolean; traffic_applied?: boolean;
  build_provider?: BuildProvider; build_engine_revision?: string; build_task_key?: string | null; static_checks_key?: string | null;
  hosting_group_id?: string; hosting_group_revision?: string;
  owner: string; repo: string; project: string; account_id: string; branch: string;
  publication_id: string; snapshot_chunks: number; snapshot_digest: string; snapshot_format?: 1; content_cutoff: string;
  destination?: { hosts: import('./domain-config').PublicationHosts; dns_mode: 'automatic' | 'external' };
  source_publication_id?: string;
  domain_revision: string; website_host: string; commit?: string | null; deployment_id?: string | null;
  release_branch?: 'main' | null; snapshot_job_id?: string; cache_purged_deployment?: string; cache_purged_hosts?: string[];
  /** Hosts frozen with this publication that must answer 301 to website_host before it is live. */
  redirect_hosts?: string[]; redirect_preparations?: RedirectPreparation[] | null;
}
function projectCreationMessage(error: ProviderError, publication?: GitPublication) {
  const detail = `Cloudflare could not create the Pages project${publication ? ` in hosting account ${publication.account_id}` : ''}: HTTP ${error.status}${error.codes.length ? ` (code ${error.codes.join(', ')})` : ''}.`;
  const connection = publication?.hosting_group_id && publication.hosting_group_id !== 'default'
    ? 'Publishing → Hosting Groups' : 'Publishing → Cloudflare account';
  if (error.codes.includes(8000011)) return `${detail} Cloudflare's Git installation is missing for this hosting account. In Cloudflare, select the hosting account → Workers & Pages → Create application → Pages → Connect to Git → + Add account. Connect ${publication?.owner ?? 'the connected GitHub account'} with access to all generated repositories, then retry publishing. Keep existing Git installations connected.`;
  if (error.status === 401 || error.status === 403) return `${detail} Open ${connection} and renew authorization for the selected hosting account. API tokens need Account Read and Pages Edit permissions for that account.`;
  if (error.status === 429) return `${detail} Cloudflare's rate limit was reached. Wait briefly and retry publishing.`;
  if (error.status >= 500) return `${detail} Cloudflare is temporarily unable to create the project. Retry publishing after the service recovers.`;
  if (error.status === 400 || error.status === 409) return `${detail} Check this account's GitHub connection and Pages project limits. In Cloudflare, select the hosting account → Workers & Pages → Create application → Pages → Connect to Git → + Add account. Authorize Cloudflare's GitHub App for ${publication?.owner ?? 'the connected GitHub account'} and its generated repositories, then retry. Include the Cloudflare code above when contacting support.`;
  return `${detail} Check the selected account in ${connection} and the Cloudflare project settings, then retry publishing.`;
}

/** Every frozen redirect host must answer 301 to the website host before the publication is live. Returns the host still failing. */
async function pendingRedirect(jobPath: string, publication: GitPublication, preparations: RedirectPreparation[] = publication.redirect_preparations ?? []): Promise<string | null> {
  if (!publication.redirect_hosts?.length) return null;
  const checks = [];
  for (const host of publication.redirect_hosts) checks.push({ host, ...await verifyRedirectHost(host, publication.website_host, publication.publication_id.slice(0, 16)) });
  const failing = checks.find(check => !check.ok);
  const preparation = preparations.find(item => item.hostname === failing?.host);
  await getStore().updateDoc(jobPath, { redirect_checks: checks, ...(failing ? {
    phase: `waiting for ${failing.host} to redirect to ${publication.website_host}`,
    verification_message: `https://${failing.host} must answer 301 to https://${publication.website_host} with the same path and query; it answered ${failing.status ?? 'no response'}${failing.location ? ` (Location: ${failing.location})` : ''}. ${preparation?.blocker?.message ?? 'Apply the redirect record and rule shown in Publishing → domains.'} Public verification will retry automatically.`,
  } : {}) });
  return failing?.host ?? null;
}

interface Target { job_id: string | null; lease_id: string | null; lease_until: number; last_publication?: GitPublication }
export type GitJob = DeployJob & { cache_recovery?: CacheRecovery; failure?: { code: string; stage?: string } | null; verification_retry?: { request_id: string; requested_at: string; failure: any }; coordinator_retries?: number; observation_started_at?: string; git_publication?: GitPublication; publication_intent?: 'domain_prepare'; domain_revision?: string; source_publication?: GitPublication };
/** One bounded queue attempt. Build waiting is durable queue backoff, never a sleeping Astro process. */
export async function executeCustomerPublication(args: EnqueueArgs): Promise<DeployRunOutcome> {
  const attemptStarted = performance.now();
  const store = getStore();
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  const job = await store.getDoc<GitJob>(jobPath);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return 'ran';
  if (job.phase === 'awaiting domain cutover approval') {
    const domains = await getSiteDomains(args.orgId, args.siteId);
    if (domains.cutover_approved_revision !== domains.revision || domains.candidate?.id !== job.git_publication?.publication_id || job.git_publication?.domain_revision !== domainPublicationRevision(domains)) return 'ran';
  }
  const targetPath = `${paths.site(args.orgId, args.siteId)}/publishing_targets/${args.versionId}`;
  const lease = randomUUID();
  await store.createDocIfMissing(targetPath, { job_id: null, lease_id: null, lease_until: 0 });
  const previousOwner = await store.getDoc<Target>(targetPath);
  if (previousOwner?.job_id && previousOwner.job_id !== args.jobId && previousOwner.lease_until < Date.now()) {
    let ownerJob = await store.getDoc<DeployJob>(paths.deploy(args.orgId, args.siteId, previousOwner.job_id));
    if (ownerJob) ownerJob = await refreshBuildFailure(args.orgId, args.siteId, ownerJob);
    if (!ownerJob || ['succeeded', 'failed'].includes(ownerJob.status) || ownerJob.phase === 'awaiting domain cutover approval') await store.compareAndUpdateDoc<Target>(targetPath,
      target => target.job_id === previousOwner.job_id && target.lease_until < Date.now(), { job_id: null });
  }
  const acquired = await store.compareAndUpdateDoc<Target>(targetPath,
    target => (!target.job_id || target.job_id === args.jobId) && target.lease_until < Date.now(),
    { job_id: args.jobId, lease_id: lease, lease_until: Date.now() + 300_000 });
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
      if (leaseLost || !await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + 300_000 })) {
        leaseLost = true;
        throw new ConnectionError('Publication ownership changed; continuing from the saved checkpoint.', 409, 'publication_lease_lost');
      }
    });
    return renewal;
  };
  // Keep ownership during an active provider request. Waiting builds release
  // ownership and the HTTP request; this timer never waits for a remote build.
  const heartbeat = setInterval(() => { void assertLease().catch(() => { leaseLost = true; }); }, 30_000);
  heartbeat.unref?.();
  const checkpoint = async (phase: string, completedPhase = phase, outcome: DeployRunOutcome = 'continue'): Promise<DeployRunOutcome> => {
    await assertLease();
    const elapsed = Math.round(performance.now() - attemptStarted);
    await store.updateDoc(jobPath, { phase, coordinator_retries: 0, coordinator: { phase: completedPhase, duration_ms: elapsed, updated_at: new Date().toISOString() } });
    console.info(JSON.stringify({ event: 'publication_checkpoint', job_id: args.jobId, phase: completedPhase, duration_ms: elapsed }));
    if (outcome === 'continue') await schedulePublication(jobPath, 'checkpoint');
    return outcome;
  };
  let terminal = false;
  let parkedCandidate = false;
  let preparingDomain = job.publication_intent === 'domain_prepare';
  const releaseBuildAccess = async () => {
    for (const environment of ['production', 'preview']) await store.compareAndUpdateDoc<any>(`${paths.site(args.orgId, args.siteId)}/publishing_build_slots/${environment}`, value => value.job_id === args.jobId, { job_id: null });
  };
  const finishPublication = async (publication: GitPublication, domains: DomainConfiguration, frozen: any): Promise<DeployRunOutcome> => {
    let previousHosts: import('./previous-hosts').PreviousHost[] = [];
    // A normal publication also finishes legacy retirement. It may add an exact
    // redirect on an existing Pages host, never move DNS or change another rule.
    const maintainPrevious = !!frozen.previous_website_hosts?.length && args.versionId === 'main' && !preparingDomain && !job.verification_retry &&
      domains.dns_mode === 'automatic' && domains.active?.website_host === publication.website_host;
    const previousPreparations = maintainPrevious ? await preparePreviousHosts(args.orgId, publication.hosting_group_id ?? 'default',
      (frozen.previous_website_hosts ?? []).filter((host: string) => !publication.redirect_hosts?.includes(host) && host !== domains.desired.media_host),
      publication.website_host, await cloudflareClient(args.orgId, fetch, undefined, publication.hosting_group_id ?? 'default'), publication.account_id, publication.project)
      : domains.approved_previous_host_preparations ?? [];
    try { previousHosts = args.versionId === 'main' ? await retirePreviousHosts(args.orgId, args.siteId,
      publication.hosting_group_id ?? 'default', publication.publication_id, frozen.previous_website_hosts ?? [], publication.website_host,
      previousPreparations, maintainPrevious || preparingDomain && !job.verification_retry && domains.candidate?.id === publication.publication_id && domains.cutover_approved_revision === domains.revision && domains.dns_mode === 'automatic', undefined,
      maintainPrevious ? jobPath : undefined) : []; }
    catch (error) {
      if (!(error instanceof ConnectionError) || error.code !== 'previous_host_unprotected') throw error;
      await store.updateDoc(jobPath, { phase: 'verifying previous website addresses', verification_message: error.message });
      return await waitForPublicationCondition(jobPath, 'verifying previous website addresses');
    }
    await recordPublishingOrigin(args.orgId, args.siteId, `https://${publication.website_host}`);
    const finished = new Date().toISOString();
    const stillOwned = await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + 60_000 });
    if (!stillOwned) return 'deferred';
    await store.updateDoc(paths.version(args.orgId, args.siteId, args.versionId), { last_deployed_at: finished, last_deployed_content_at: publication.content_cutoff, deploy_url: `https://${publication.website_host}` });
    if (args.versionId === 'main') {
      const currentDomains = await getSiteDomains(args.orgId, args.siteId);
      const active = { ...domains.desired, website_host: publication.website_host };
      const matchesDesired = samePublicationHosts(currentDomains.desired, active) && sameRedirectHosts(currentDomains.desired, active);
      const outdated = !preparingDomain && currentDomains.candidate && currentDomains.candidate.source_publication_id !== publication.publication_id;
      await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === currentDomains.revision,
        { active, previous_hosts: previousHosts, active_dns_mode: domains.dns_mode, published: { hosts: active, dns_mode: domains.dns_mode, publication_id: publication.publication_id, job_id: args.jobId },
          ...(preparingDomain || matchesDesired ? {state: 'live'} : outdated ? {state:'outdated', cutover_approved_revision:null} : {}),
          media_aliases: [...currentDomains.media_aliases, ...(currentDomains.active && !currentDomains.media_aliases.some(alias => samePublicationHosts(alias, currentDomains.active!)) ? [currentDomains.active] : [])] });
      if (outdated && currentDomains.candidate?.job_id) await store.compareAndUpdateDoc<any>(paths.deploy(args.orgId, args.siteId, currentDomains.candidate.job_id),
        value => value.status === 'running', {status:'failed',phase:'superseded',finished_at:finished,error:'Newer content was published at the current address. Prepare for domain switch again before changing traffic.'});
      await store.updateDoc(paths.site(args.orgId, args.siteId), { domain: publication.website_host, domain_status: 'live', domain_verified_at: finished });
    }
    await recordPublishedMedia(args.orgId, args.siteId, frozen.media_manifest?.entries ?? [], { main: args.versionId === 'main' });
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
    await assertLease();
    await completeDomainCutover(args.orgId, args.siteId, publication.publication_id);
    await store.updateDoc(jobPath, { status: 'succeeded', phase: 'live', deploy_url: `https://${publication.website_host}`, verification_message: null, static_probe: null, finished_at: finished });
    terminal = true;
    return 'ran';
  };
  try {
    await store.updateDoc(jobPath, { coordinator_observed_at: new Date().toISOString() });
    const currentDomains = await getSiteDomains(args.orgId, args.siteId);
    if (args.versionId === 'main' && currentDomains.state === 'distributing' && currentDomains.candidate?.job_id && currentDomains.candidate.job_id !== args.jobId) {
      await store.updateDoc(jobPath, { waiting_for_job_id: currentDomains.candidate.job_id, phase: 'waiting for the domain traffic switch' });
      parkedCandidate = true;
      return 'deferred';
    }
    if (currentDomains.rollback_requested && currentDomains.candidate && currentDomains.candidate.id === job.git_publication?.publication_id) {
      const rollback = await rollbackDomainCutover(args.orgId, args.siteId, currentDomains.candidate.id);
      await store.updateDoc(jobPath, { status: 'failed', phase: rollback?.state === 'rolled_back' ? 'previous traffic restored' : 'rollback needs attention', error: rollback?.errors.join(' ') || 'The traffic switch was rolled back.', finished_at: new Date().toISOString() });
      terminal = true; return 'ran';
    }
    if (job.git_publication) {
      const cutover = await readDomainCutover(args.orgId, args.siteId, job.git_publication.publication_id);
      if (cutover?.state === 'armed' && cutover.deadline_at <= Date.now()) throw new ConnectionError('The agreed traffic validation window expired. Restoring previous DNS.', 409, 'domain_cutover_timeout');
    }
    if (job.verification_retry) await assertVerificationRetry(args.orgId, args.siteId, job, true);
    const buildTask = job.git_publication?.build_task_key
      ? await store.getDoc<BuildTask>(`${buildTasksPath(args.orgId)}/${job.git_publication.build_task_key}`) : null;
    const observationStart = Math.max(Date.parse(job.observation_started_at ?? job.started_at), buildTask?.completed_at ?? 0);
    const preparingBuild = buildTask && ['queued', 'running'].includes(buildTask.status) && buildTask.deadline > Date.now();
    // Preserve the build's actual failure instead of masking it with the later
    // public-verification timeout after a long media preparation phase.
    if (buildTask && ['failed', 'cancelled'].includes(buildTask.status)) await completedBuild(args.orgId, job.git_publication!.build_task_key!);
    if (!preparingBuild && Number.isFinite(observationStart) && Date.now() - observationStart > 45 * 60_000) throw new ConnectionError(job.verification_message ? `Publication verification stopped after 45 minutes. ${job.verification_message.replace('Public verification will retry automatically.', '').trim()} Contact support with deployment ${args.jobId}.` : 'Publication verification did not finish within 45 minutes. Check the Cloudflare build and domain status, then retry.', 409, 'publication_observation_timeout');
    if (buildTask && ['queued', 'running'].includes(buildTask.status)) {
      if (buildTask.lease_until > Date.now()) return await waitForBuild(jobPath, args.orgId, job.git_publication!.build_task_key!);
      if (!await completedBuild(args.orgId, job.git_publication!.build_task_key!)) {
        const remaining = buildTask.media_total && (buildTask.media_cursor ?? 0) < buildTask.media_total;
        await assertLease();
        await store.updateDoc(jobPath, { phase: remaining
          ? `preparing media: ${buildTask.media_cursor ?? 0} of ${buildTask.media_total} files ready; continuing automatically`
          : job.git_publication?.build_provider === 'github' ? 'building on GitHub Actions' : 'building on Cloudflare' });
        return await waitForBuild(jobPath, args.orgId, job.git_publication!.build_task_key!);
      }
    }
    const verificationKey = job.git_publication?.verification_task_key;
    if (verificationKey) {
      const verifying = await store.getDoc<BuildTask>(`${buildTasksPath(args.orgId)}/${verificationKey}`);
      if (verifying && ['queued', 'running'].includes(verifying.status)) {
        if (verifying.lease_until <= Date.now()) await completedBuild(args.orgId, verificationKey);
        return await waitForBuild(jobPath, args.orgId, verificationKey);
      }
    }
    if (args.environment === 'staging' && args.versionId === 'main') throw new ConnectionError('Select a site version to publish a test deployment. The main version publishes the live website.', 409, 'publication_version_required');
    await assertPublishingReady(args.orgId, args.siteId, args.versionId, { checkBuild: false });
    const group = await (args.dryRun ? siteHostingGroup : lockSiteHostingGroup)(args.orgId, args.siteId);
    const [gitConnection, cfConnection, savedDomains, organization, site] = await Promise.all([
      getConnection(args.orgId, 'github'), getConnection(args.orgId, 'cloudflare', group.id), getSiteDomains(args.orgId, args.siteId),
      getOrganizationDomains(args.orgId), store.getDoc<Site>(paths.site(args.orgId, args.siteId)),
    ]);
    const applyingApprovedDomains = savedDomains.cutover_approved_revision === savedDomains.revision &&
      savedDomains.candidate?.id === job.git_publication?.publication_id;
    const domains = preparingDomain || applyingApprovedDomains ? savedDomains : activePublicationDomains(savedDomains, site?.publishing_migration?.website_host);
    preparingDomain ||= args.versionId === 'main' && hasPendingPublishedDomains(savedDomains);
    const fallback = `${args.versionId === 'main' ? '' : `v-${digest(args.versionId).slice(0, 8)}-`}${generatedCloudflareNames(args.orgId, args.siteId).site_label}.${group.sites_domain}`;
    if (!preparingDomain && (!domains.desired.website_host || domains.desired.website_host === fallback)) domains.dns_mode = group.dns_mode;
    // A prepared candidate cannot replace content published after its source snapshot.
    if (job.publication_intent === 'domain_prepare' && !job.git_publication && (!job.source_publication?.publication_id || acquired.last_publication?.publication_id !== job.source_publication.publication_id)) {
      throw new ConnectionError('Newer content was published at the current address. Prepare for domain switch again.', 409, 'domain_candidate_outdated');
    }
    const identity = gitConnection.github!;
    let publication = job.git_publication;
    // A legacy preview is not the currently deployed main output and cannot switch traffic.
    if (publication?.release_branch) throw new ConnectionError('Publish for the new domain again to replace the current site. This older preparation used a separate preview.', 409, 'domain_republication_required');
    if (!publication) {
      await store.updateDoc(jobPath, { status: 'running', phase: 'freezing source', execution_backend: 'customer_git' });
      if (job.publication_intent === 'domain_prepare' && job.domain_revision !== domainPublicationRevision(domains)) throw new ConnectionError('Domain settings changed. Prepare a new candidate.', 409);
      const priorPublication = job.source_publication ?? acquired.last_publication;
      const prior = priorPublication?.snapshot_job_id ? await readSnapshot({ ...args, jobId: priorPublication.snapshot_job_id }, priorPublication) : null;
      const contentCutoff = job.publication_intent === 'domain_prepare' ? priorPublication!.content_cutoff : new Date().toISOString();
      const generated = generatedCloudflareNames(args.orgId, args.siteId);
      const fallbackHost = `${args.versionId === 'main' ? '' : `v-${digest(args.versionId).slice(0, 8)}-`}${generated.site_label}.${group.sites_domain}`;
      const host = args.versionId === 'main' && domains.desired.website_host ||
        `${args.versionId === 'main' ? '' : `v-${digest(args.versionId).slice(0, 8)}-`}${generated.site_label}.${group.sites_domain}`;
      // Redirect hosts belong to the live website host only, never to version addresses.
      const redirectHosts = args.versionId === 'main' && domains.desired.website_host === host ? domains.desired.redirect_hosts ?? [] : [];
      let frozen: Record<string, any>;
      if (job.publication_intent === 'domain_prepare') {
        if (!prior) throw new ConnectionError('The last public snapshot is missing. Publish the site before preparing domains.', 409);
        frozen = structuredClone(prior);
        // Start a new immutable attempt with the installed renderer, while keeping
        // the published content frozen. Resuming this job never changes its renderer.
        frozen.core_commit = process.env.TYPEROLL_SOURCE_SHA ?? prior.core_commit;
        frozen.robots_blocked = args.versionId !== 'main' || host === fallbackHost;
        frozen.settings.sitewide_noindex = frozen.robots_blocked || frozen.authored_noindex === true;
      } else {
        const resolved = await resolvePublicationVersion(args.orgId, args.siteId, args.versionId);
        const publicRuntime = await publicationRuntime(args.orgId, args.siteId, args.versionId);
        // Derived data is computed from the frozen content, before rendering,
        // and frozen into the artifact alongside it. A required provider that
        // fails throws here — which is how the previous live artifact keeps
        // serving, since activation only happens after every step succeeds.
        frozen = projectStaticPublication({ ...resolved, site: { ...site, domain: host }, media: [], forms: publicRuntime.forms, extensions: publicRuntime.extensions.installations, publicRuntime }, {
          siteUrl: `https://${host}`, coreCommit: process.env.TYPEROLL_SOURCE_SHA ?? '', publishedAt: contentCutoff,
          noindex: args.versionId !== 'main' || host === fallbackHost, coreBlockTypes: CORE_BLOCK_TYPES,
        });
        // Project first: private fields, provenance and drafts must not reach a provider.
        const content = { version_id: resolved.versionId, pages: frozen.pages, content_types: frozen.contentTypes };
        const derivation = await runBuildDerivations(
          {
            org_id: args.orgId, site_id: args.siteId, version_id: resolved.versionId,
            content_digest: publicationContentDigest(content), content,
            config_digest: publicationConfigDigest(publicRuntime),
            provider_version: '',
          },
          await derivationProvidersFor(args.orgId, args.siteId, publicRuntime.extensions),
        );
        frozen.authored_noindex = resolved.settings?.sitewide_noindex === true;
        if (derivation.sources.length > 0) {
          frozen.derived = Object.fromEntries(derivation.sources.map(source => [source.id, source.records]));
        }
        // Receipts join the existing dependency list so a partial build knows
        // derived output depends on records outside the pages it rendered.
        // A zero-count receipt matters most: without it, adding the first
        // matching record leaves a stale empty listing nothing invalidates.
        if (derivation.receipts.length > 0 || derivation.skipped.length > 0) {
          frozen.derivation = { receipts: derivation.receipts, cache_keys: derivation.cache_keys,
            ...(derivation.skipped.length > 0 ? { skipped: derivation.skipped } : {}) };
        }
      }
      // Media originals and metadata for a domain-only build come from the public snapshot too.
      const deferReferences = job.publication_intent !== 'domain_prepare' || Boolean(prior?.reference_mapping);
      const mapped = await publicationMediaManifest(args.orgId, args.siteId, frozen, host, job.publication_intent === 'domain_prepare' ? prior : undefined, { deferReferences, domains, dryRun: args.dryRun === true });
      // Non-blocking findings (for example media left out of this publication) stay on the job for users and agents.
      const warnings = [...mapped.warnings, ...publicationLanguageWarnings(frozen)];
      if (warnings.length) await store.updateDoc(jobPath, { warnings });
      // Compare the exact media records frozen into the manifest, without a second datastore read.
      const impactSnapshot = job.publication_intent === 'domain_prepare' ? null : await capturePublicationImpact(frozen, args.orgId, args.siteId, domains, organization, mapped.sourceMedia);
      // Links to a redirect host (for example https://www.example.com/page) are frozen as links to the website host.
      const previousOrigins = [site?.domain ? `https://${site.domain}` : '', prior?.site_url ?? '', ...(prior?.reference_mapping?.website_origins ?? []),
        ...redirectHosts.map(redirect => `https://${redirect}`)].filter(Boolean);
      frozen = deferReferences ? { ...mapped.content, reference_mapping: { format: 1, media: (mapped.content as any).reference_mapping?.media ?? [], website_origins: [...new Set(previousOrigins)] } }
        : retargetWebsite(mapped.content, previousOrigins, `https://${host}`);
      frozen = { ...frozen, site_url: `https://${host}`, site: { ...frozen.site, domain: host }, media: mapped.media, media_manifest: mapped.manifest };
      if (impactSnapshot) {
        frozen.source_impact_snapshot = impactSnapshot;
        await store.updateDoc(jobPath, { build_impact: compareImpact(prior?.source_impact_snapshot, impactSnapshot) });
      } else {
        delete frozen.source_impact_snapshot;
      }
      const retained = [...(prior?.retained_media_manifests ?? []), ...((prior?.media_manifest?.delivery === 'static' || prior?.media_manifest?.media_host === prior?.media_manifest?.website_host) && prior?.media_manifest ? [prior.media_manifest] : [])];
      frozen.media_replacement_redirects = replacedMediaRedirects(retained, frozen.media_manifest, frozen.redirects, prior?.media_replacement_redirects);
      frozen.redirects = [...frozen.redirects ?? [], ...frozen.media_replacement_redirects.filter((rule: any) => !frozen.redirects?.some((existing: any) => existing.from_path === rule.from_path))];
      frozen.retained_media_manifests = retainDistinctMediaManifests(retained, frozen.media_manifest);
      frozen.previous_website_hosts = args.versionId === 'main'
        ? previousWebsiteHosts(savedDomains, host, prior?.site_url ? new URL(prior.site_url).hostname : undefined) : [];
      // Theme fonts are copied now, so no build engine needs network access or Google to render them.
      const themeFonts = await freezeThemeFonts(frozen.settings?.fonts, prior?.theme_fonts);
      if (themeFonts) frozen.theme_fonts = themeFonts; else delete frozen.theme_fonts;
      // Content identity excludes wall-clock metadata so an unchanged publication can reuse the previous build.
      const stable = { ...frozen, published_at: undefined, publication_id: undefined,
        // An explicit domain republication gets a fresh approval/journal identity,
        // including after rollback. Retries of this same job remain deterministic.
        ...(job.publication_intent === 'domain_prepare' ? { domain_transition_id: args.jobId } : {}) };
      frozen.publication_id = digest(JSON.stringify(stable));
      if (args.dryRun) {
        await publicationSourceTree(frozen);
        assertDryRunValidation(frozen.pages ?? []);
        await store.updateDoc(jobPath, { status: 'succeeded', phase: 'source verified (dry-run, no Git push)', dry_run: true, finished_at: contentCutoff });
        terminal = true; return 'ran';
      }
      const servedHost = preparingDomain ? savedDomains.active?.website_host ?? fallback : host;
      if (acquired.last_publication && acquired.last_publication.publication_id === frozen.publication_id &&
          await probePublication(`https://${servedHost}`, '/.well-known/typeroll/publication.json', frozen.publication_id)) {
        if (frozen.previous_website_hosts?.some((host: string) => !savedDomains.previous_hosts?.some(previous =>
          previous.host === host && previous.target_host === servedHost && previous.mode === 'redirect' && previous.status === 'verified'))) {
          // Permission may have been approved since an unchanged publication's
          // noindex fallback. Finish retirement without rebuilding its artifact.
          return await finishPublication(acquired.last_publication, domains, frozen);
        }
        await store.updateDoc(jobPath, { status: 'succeeded', phase: 'unchanged', finished_at: contentCutoff, deploy_url: `https://${servedHost}` });
        terminal = true; return 'ran';
      }
      publication = { hosting_group_id: group.id, hosting_group_revision: group.revision, owner: identity.owner, repo: site?.git_repository ?? generated.pages_project!, project: site?.publishing_migration?.project ?? generated.pages_project!, account_id: cfConnection.cloudflare!.account_id,
        branch: frozen.git_branch, publication_id: frozen.publication_id, content_cutoff: contentCutoff,
        domain_revision: domainPublicationRevision(domains), destination: {hosts: domains.desired, dns_mode: domains.dns_mode},
        ...(job.source_publication ? {source_publication_id: job.source_publication.publication_id} : {}), website_host: host, snapshot_job_id: args.jobId, ...(redirectHosts.length ? { redirect_hosts: redirectHosts } : {}), ...await saveSnapshot(args, frozen) };
      const selectedProvider = await selectedBuildProvider(args.orgId);
      const engine = await readEngineConfiguration(args.orgId, selectedProvider);
      if (site?.publishing_migration && engine?.status !== 'ready') throw new ConnectionError('Restore the shared build engine before publishing this migrated site.', 409, 'shared_build_setup_required');
      if (selectedProvider === 'github' && !engine) throw new ConnectionError('Finish build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
      if (engine && engine.status !== 'ready') throw new ConnectionError('Finish shared build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
      if (engine?.status === 'ready') { publication.build_engine_revision = engine.revision; publication.build_provider = engine.provider ?? 'cloudflare'; }
      // Domain publication replaces main immediately; DNS approval never pushes a second branch.
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication });
      return await checkpoint('source frozen');
    }
    // Approval belongs to the exact deployed artifact, never merely its hosts.
    if (domains.candidate?.id !== publication.publication_id) domains.cutover_approved_revision = null;
    const config = githubConfiguration();
    let githubClient: Awaited<ReturnType<typeof githubInstallationClient>> | undefined;
    const github: Awaited<ReturnType<typeof githubInstallationClient>> = async (path, options) => {
      githubClient ??= await githubInstallationClient({ appId: config.appId, installationId: identity.installation_id, owner: identity.owner, privateKey: config.privateKey });
      return githubClient(path, options);
    };
    const cloudflare = await cloudflareClient(args.orgId, fetch, undefined, group.id);
    if (site?.publishing_migration) {
      if (site.publishing_migration.account_id !== cfConnection.cloudflare?.account_id || site.publishing_migration.hosting_group_id !== group.id) throw new ConnectionError('The migrated Pages project belongs to a different hosting account. Restore its original Hosting Group connection.', 409, 'managed_account_mismatch');
      await verifyManagedProject(cloudflare, site.publishing_migration);
    }
    const currentHost = args.versionId === 'main' && domains.desired.website_host || fallback;
    if (!preparingDomain && (publication.release_branch || publication.website_host !== currentHost)) {
      throw new ConnectionError('This older job targets future domains. Publish normally at the current address, then explicitly prepare for domain switch.', 409, 'explicit_domain_preparation_required');
    }
    if ((publication.hosting_group_id ?? 'default') !== group.id || (publication.hosting_group_revision && publication.hosting_group_revision !== group.revision) || publication.account_id !== cfConnection.cloudflare?.account_id || publication.owner !== identity.owner || (preparingDomain ? publication.domain_revision !== domainPublicationRevision(savedDomains) :
      publication.destination ? !samePublicationHosts(publication.destination.hosts, domains.desired) || !sameRedirectHosts(publication.destination.hosts, domains.desired) || publication.destination.dns_mode !== domains.dns_mode : publication.domain_revision !== domains.revision)) {
      throw new ConnectionError('Publishing accounts or domain settings changed. Start a new deployment.', 409);
    }
    if (job.verification_retry) {
      if (await applyApprovedCacheRefresh(args.orgId, jobPath, publication)) return await waitForPublicationCondition(jobPath, 'verifying refreshed cache');
    }
    // A domain preparation that has not switched traffic resumes its own checkpointed flow, which verifies the current address.
    if (job.verification_retry && !(preparingDomain && !publication.traffic_applied)) {
      // Recovery keeps the served artifact. A separately approved cache refresh
      // may run here, but never source generation, builds, uploads or DNS.
      const frozen = await readSnapshot(args, publication);
      const mediaHost = frozen.media_manifest?.delivery === 'static' ? frozen.media_manifest.media_host : null;
      const origins = [...new Set([`https://${publication.website_host}`, ...(mediaHost ? [`https://${mediaHost}`] : [])])];
      for (const origin of origins) {
        const markerReady = await probePublication(origin, '/.well-known/typeroll/publication.json', publication.publication_id);
        if (!markerReady || !await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key!, origin, true)) {
          if (markerReady) {
            await recoverPublicationCache(args.orgId, jobPath, publication, origin, undefined, false);
          }
          await store.updateDoc(jobPath, { phase: 'retrying public verification' });
          return await waitForPublicationCondition(jobPath, 'retrying public verification');
        }
      }
      if (await pendingRedirect(jobPath, publication)) return await waitForPublicationCondition(jobPath, 'retrying public verification');
      await assertLease();
      return await finishPublication(publication, domains, frozen);
    }
    const projectRoot = `/accounts/${publication.account_id}/pages/projects/${publication.project}`;
    // The account may be shared with other Organizations: operate only on a project recorded as this Organization's.
    await claimCloudflareResource(args.orgId, publication.account_id, 'pages_project', publication.project, { siteId: args.siteId });
    if (!publication.commit) {
      const frozen = await readSnapshot(args, publication);
      const files = await publicationSourceTree(frozen);
      // The repository name is settled with GitHub here, not while freezing the source.
      const repo = await siteRepositoryName(args.orgId, args.siteId, site, github, publication.owner);
      if (repo !== publication.repo) {
        publication = { ...publication, repo };
        await assertLease();
        await store.updateDoc(jobPath, { git_publication: publication });
      }
      const repoRoot = `/repos/${publication.owner}/${publication.repo}`;
      let repository = await github(repoRoot, { missing: true });
      if (!repository) {
        await createGithubRepository(args.orgId, github, identity, {
          name: publication.repo, private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false,
          description: generatedRepositoryDescription(args.orgId, args.siteId),
        });
        repository = await github(repoRoot);
      }
      if (repository.private !== true || String(repository.owner?.id) !== identity.account_id || repository.archived || repository.description !== generatedRepositoryDescription(args.orgId, args.siteId)) {
        throw new ConnectionError('The generated repository does not match this organization. Check GitHub publishing access.', 409);
      }
      repository = await ensureGithubMainBranch(github, { owner: publication.owner, repo: publication.repo, repository });
      let connectedProject = publication.build_engine_revision
        ? await prepareStaticProject(cloudflare, projectRoot, { project: publication.project, owner: publication.owner, repo: publication.repo, repository, requireExisting: Boolean(site?.publishing_migration) })
        : await cloudflare(projectRoot, { missing: true });
      if (!connectedProject) {
        await store.updateDoc(jobPath, { phase: 'creating Cloudflare Pages project' });
        await cloudflare(`/accounts/${publication.account_id}/pages/projects`, { method: 'POST', body: pagesProjectBody({ owner: publication.owner, repo: publication.repo, repository, project: publication.project }) });
        connectedProject = await cloudflare(projectRoot);
      }
      if (!publication.build_engine_revision && (connectedProject.source?.type !== 'github' || String(connectedProject.source.config?.repo_id) !== String(repository.id))) throw new ConnectionError('Cloudflare is connected to a different repository.', 409);
      if (!publication.build_engine_revision && (frozen.media_manifest?.entries?.length || frozen.retained_media_manifests?.length)) {
        const environment = publication.branch === 'main' ? 'production' : 'preview';
        // Pages shares preview environment variables across version branches. Keep the grant stable until this build finishes.
        const buildSlot = `${paths.site(args.orgId, args.siteId)}/publishing_build_slots/${environment}`;
        await store.createDocIfMissing(buildSlot, { job_id: null });
        const previousSlot = await store.getDoc<{ job_id: string | null }>(buildSlot);
        if (previousSlot?.job_id && previousSlot.job_id !== args.jobId) {
          const previousJob = await store.getDoc<DeployJob>(paths.deploy(args.orgId, args.siteId, previousSlot.job_id));
          if (!previousJob || ['failed', 'succeeded'].includes(previousJob.status)) await store.compareAndUpdateDoc<any>(buildSlot, value => value.job_id === previousSlot.job_id, { job_id: null });
        }
        const accessSlot = await store.compareAndUpdateDoc<any>(buildSlot, value => !value.job_id || value.job_id === args.jobId, { job_id: args.jobId });
        if (!accessSlot) { await store.updateDoc(jobPath, { phase: 'waiting for the previous version build' }); return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider'); }
        const access = await customerBuildMediaAccess(args.orgId, args.siteId, frozen.media_manifest, frozen.publication_id, frozen.retained_media_manifests);
        await setPagesBuildMediaAccess(cloudflare, projectRoot, environment, access);
      }
      await store.updateDoc(jobPath, { phase: 'publishing to GitHub' });
      await assertLease();
      const pushed = await publishTree(github, { owner: publication.owner, repo: publication.repo, branch: publication.branch, files, message: `Publish ${args.versionId} ${publication.publication_id.slice(0, 12)}` });
      publication = { ...publication, commit: pushed.commit, project_prepared: true };
      // Record the Git commit before Pages setup: recovery must never capture newer CMS edits.
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication });
      return await checkpoint(publication.build_engine_revision ? 'preparing static build' : 'connecting Cloudflare build', 'source published');
    }
    let project = publication.deployment_receipt ? { uses_functions: false, latest_deployment: publication.deployment_receipt } : await cloudflare(projectRoot, { missing: true });
    if (publication.build_engine_revision && !publication.project_prepared) {
      const repository = await github(`/repos/${publication.owner}/${publication.repo}`);
      project = await prepareStaticProject(cloudflare, projectRoot, { project: publication.project, owner: publication.owner, repo: publication.repo, repository, requireExisting: Boolean(site?.publishing_migration) });
    }
    if (!project) {
      const repository = await github(`/repos/${publication.owner}/${publication.repo}`);
      await store.updateDoc(jobPath, { phase: 'creating Cloudflare Pages project' });
      await cloudflare(`/accounts/${publication.account_id}/pages/projects`, { method: 'POST', body: pagesProjectBody({ owner: publication.owner, repo: publication.repo, repository, project: publication.project }) });
      project = await cloudflare(projectRoot);
    }
    if (!publication.build_engine_revision && !publication.candidate_verified_id && (project.source?.type !== 'github' || project.source.config?.owner !== publication.owner || project.source.config?.repo_name !== publication.repo ||
        project.production_branch !== 'main' || project.build_config?.build_command !== 'npm ci && npm run build')) {
      throw new ConnectionError('Cloudflare must use the generated GitHub repository and static build configuration.', 409);
    }
    if (!publication.commit) throw new Error('Frozen publication has no Git commit');
    let deployment = publication.deployment_receipt ?? (publication.deployment_id ? await cloudflare(`${projectRoot}/deployments/${encodeURIComponent(publication.deployment_id)}`) : await findPublicationDeployment(cloudflare, projectRoot, { project: publication.project, commit: publication.commit, branch: publication.branch, ignoreSkipped: Boolean(publication.build_engine_revision) }));
    if (publication.build_engine_revision) {
      const engine = await readEngineConfiguration(args.orgId, publication.build_provider ?? 'cloudflare');
      if (!engine || engine.status !== 'ready' || engine.revision !== publication.build_engine_revision) throw new ConnectionError('The shared build engine changed. Retry this publication.', 409);
      if (!publication.build_task_key) {
        if (!engine.static_verification) throw new ConnectionError('Update the build engine in Publishing → Builds before publishing.', 409, 'build_engine_update_required');
        const source = await publicationSourceTree(await readSnapshot(args, publication));
        const queued = await enqueueBuild(engine, { org_id: args.orgId, site_id: args.siteId, version_id: args.versionId, job_id: args.jobId,
          publication_id: publication.publication_id, commit: publication.commit, branch: publication.branch }, source);
        await assertLease();
        publication = { ...publication, build_task_key: queued.key };
        await store.updateDoc(jobPath, { git_publication: publication, execution_backend: publication.build_provider === 'github' ? 'organization_github' : 'organization_cloudflare' });
        await checkpoint(publication.build_provider === 'github' ? 'building on GitHub Actions' : 'building on Cloudflare', 'build dispatched', 'waiting');
        return await waitForBuild(jobPath, args.orgId, queued.key);
      }
      if (!deployment || !publication.static_checks_key) {
        const result = await completedBuild(args.orgId, publication.build_task_key!);
        if (!result) {
          const task = await store.getDoc<BuildTask>(`${buildTasksPath(args.orgId)}/${publication.build_task_key}`);
          const remaining = task?.media_total && (task.media_cursor ?? 0) < task.media_total;
          await store.updateDoc(jobPath, { phase: remaining
            ? `preparing media: ${task.media_cursor ?? 0} of ${task.media_total} files ready; continuing automatically`
            : publication.build_provider === 'github' ? 'building on GitHub Actions' : 'building on Cloudflare' });
          return await waitForBuild(jobPath, args.orgId, publication.build_task_key!);
        }
        const staticChecks = await saveStaticChecks(args.orgId, result.files, acquired.last_publication?.static_checks_key ?? undefined, result.direct);
        publication = { ...publication, static_checks_key: staticChecks };
        if (result.direct && engine.static_verification) publication = { ...publication, ...await saveCustomerVerification(args.orgId, publication, result.direct, acquired.last_publication) };
        await store.updateDoc(jobPath, { git_publication: publication, phase: 'uploading static files to the Hosting Group',
          ...(result.task.seo_report ? { seo_report: result.task.seo_report } : {}),
          ...(result.task.render_report ? { render_report: result.task.render_report } : {}) });
        if (!deployment) {
          await assertLease();
          deployment = result.direct ? await finalizeDirectUpload(cloudflare, { account: publication.account_id, project: publication.project, branch: publication.branch, commit: publication.commit! }, result.direct) : await uploadStaticBuild(cloudflare, { org: args.orgId, group: group.id, account: publication.account_id,
            project: publication.project, branch: publication.branch, commit: publication.commit! }, result.files);
        }
      }
    }
    if (deployment?.id && publication.deployment_id !== deployment.id) {
      publication = { ...publication, deployment_id: deployment.id, public_media_prepared: true };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    if (!deployment || deployment.latest_stage?.name !== 'deploy' || deployment.latest_stage?.status !== 'success') {
      if (deployment?.is_skipped || ['failure', 'canceled'].includes(deployment?.latest_stage?.status)) throw new ConnectionError('The Cloudflare build failed. Open the generated project in Cloudflare → Workers & Pages → Deployments for the build log.', 502, 'customer_build_failed');
      await store.updateDoc(jobPath, { status: 'running', phase: publication.build_engine_revision ? 'distributing static files on Cloudflare' : 'building on Cloudflare' });
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    const candidate = new URL(deployment.url);
    if (publication.candidate_verified_id !== deployment.id) {
      if (deployment.uses_functions == null) deployment = await cloudflare(`${projectRoot}/deployments/${encodeURIComponent(deployment.id)}`);
      if (!matchingDeployment([deployment], { project: publication.project, commit: publication.commit!, branch: publication.branch })) throw new ConnectionError('Cloudflare returned a different deployment. Retry verification of the generated Git commit.', 409, 'deployment_identity_mismatch');
      try { assertSuccessfulStaticDeployment(deployment, project); }
      catch { throw new ConnectionError('Cloudflare has not confirmed that this exact deployment uses static files only. Open the Cloudflare build status before retrying.', 409, 'static_build_verification_required'); }
      await releaseBuildAccess();
      if (candidate.protocol !== 'https:' || !candidate.hostname.endsWith(`.${publication.project}.pages.dev`) || candidate.username || candidate.password || candidate.port) throw new Error('Unexpected Cloudflare deployment origin');
      if (preparingDomain && args.versionId === 'main' && domains.cutover_approved_revision !== domains.revision) {
        // Pages has replaced main. Preserve those embedded origins even if a later
        // DNS/certificate check fails; the next content publication must not revert them.
        await assertLease();
        const hosts = { ...domains.desired, website_host: publication.website_host };
        const recorded = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId),
          current => current.state !== 'distributing',
          { published: { hosts, dns_mode: domains.dns_mode, publication_id: publication.publication_id, job_id: args.jobId },
            media_aliases: [...savedDomains.media_aliases, ...(savedDomains.active && !savedDomains.media_aliases.some(alias => samePublicationHosts(alias, savedDomains.active!)) ? [savedDomains.active] : [])] });
        if (!recorded) throw new ConnectionError('Domain settings changed after the main publication. Refresh domain status before switching traffic.', 409, 'domain_revision_conflict');
      }
      if (!await probePublication(candidate.origin, '/.well-known/typeroll/publication.json', publication.publication_id)) return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
      if (publication.verification_checks_key && !await verifyCustomerCandidate(args.orgId, jobPath, publication, candidate.origin)) {
        await store.updateDoc(jobPath, { phase: 'verifying static output on the organization build engine' }); return await waitForBuild(jobPath, args.orgId, publication.verification_task_key!);
      }
      if (publication.static_checks_key && !await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key ?? publication.static_checks_key, candidate.origin, !!publication.probe_checks_key)) {
        await store.updateDoc(jobPath, { phase: 'verifying static output' }); return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
      }
      publication = { ...publication, candidate_verified_id: deployment.id, candidate_prepared_at: publication.candidate_prepared_at ?? new Date().toISOString(),
        deployment_receipt: { id: deployment.id, url: deployment.url, uses_functions: false, latest_stage: deployment.latest_stage, deployment_trigger: deployment.deployment_trigger } };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    if (preparingDomain && args.versionId === 'main' && domains.cutover_approved_revision !== domains.revision)
      await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
    await recordPublishingOrigin(args.orgId, args.siteId, candidate.origin, true);
    const frozen = await readSnapshot(args, publication);
    if (!publication.public_media_prepared && frozen.media_manifest?.entries?.length && !await preparePublicMediaDomains(args.orgId, frozen.media_manifest)) {
      await store.updateDoc(jobPath, { phase: 'distributing media' });
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    publication = { ...publication, deployment_id: deployment.id, public_media_prepared: true };
    await assertLease();
    await store.updateDoc(jobPath, { git_publication: publication, phase: 'ready to connect domain' });
    const dnsMode = args.versionId === 'main' && domains.desired.website_host ? domains.dns_mode : group.dns_mode;
    const dns = dnsMode === 'automatic' ? await hostingDns(args.orgId, group.id, publication.website_host) : null;
    const preparation = publication.website_preparation ?? await preparePagesDomain(cloudflare, { accountId: publication.account_id, project: publication.project,
      branch: publication.branch, hostname: publication.website_host,
      configureTraffic: !preparingDomain && domains.cutover_approved_revision !== domains.revision, dnsProvider: dns?.provider, dnsAccountId: dns?.accountId,
      dnsMode, orgId: args.orgId });
    let mediaPreparation: import('./domain-provider').DomainPreparation | null = null;
    let mediaDns: Awaited<ReturnType<typeof hostingDns>> | null = null;
    const mediaManifest = frozen.media_manifest;
    if (mediaManifest?.delivery === 'static' && mediaManifest.media_host !== publication.website_host) {
      mediaDns = domains.dns_mode === 'automatic' ? await hostingDns(args.orgId, group.id, mediaManifest.media_host) : null;
      mediaPreparation = publication.media_preparation ?? await preparePagesDomain(cloudflare, { accountId: publication.account_id, project: publication.project,
        branch: publication.branch, hostname: mediaManifest.media_host, dnsMode: domains.dns_mode,
        dnsProvider: mediaDns?.provider, dnsAccountId: mediaDns?.accountId, configureTraffic: !preparingDomain && domains.cutover_approved_revision !== domains.revision, orgId: args.orgId });
    }
    if (!sameRedirectHosts({ ...domains.desired, redirect_hosts: publication.redirect_hosts }, domains.desired)) {
      publication = { ...publication, redirect_hosts: domains.desired.redirect_hosts ?? [], redirect_preparations: null };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    // Redirect hosts never reach Pages: a zone redirect rule answers them once their record is proxied.
    const redirectPreparations: RedirectPreparation[] = publication.redirect_preparations ?? (publication.redirect_hosts?.length
      ? await prepareRedirectHosts(args.orgId, group.id, { hosts: publication.redirect_hosts, target: publication.website_host, dnsMode, configureTraffic: !preparingDomain && domains.cutover_approved_revision !== domains.revision })
      : []);
    const redirectBlockers = redirectPreparations.map(redirectApprovalBlocker).filter((blocker): blocker is { code: string; message: string } => Boolean(blocker));
    if (preparation.action === 'verify' && preparation.certificate_ready) {
      publication = { ...publication, website_preparation: preparation, ...(mediaPreparation?.action === 'verify' && mediaPreparation.certificate_ready ? { media_preparation: mediaPreparation } : {}) };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    if (redirectPreparations.length && !publication.redirect_preparations && redirectPreparations.every(item => item.action === 'verify')) {
      publication = { ...publication, redirect_preparations: redirectPreparations };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    const requirements = [...preparation.requirements, ...redirectPreparations.flatMap(item => item.requirements)];
    if (preparingDomain && args.versionId === 'main' && domains.cutover_approved_revision !== domains.revision) {
      // Main already serves this artifact. Verify the existing address before offering DNS activation.
      const currentHost = savedDomains.active?.website_host ?? fallback;
      const currentOrigin = `https://${currentHost}`;
      const markerReady = await probePublication(currentOrigin, '/.well-known/typeroll/publication.json', publication.publication_id);
      if (!markerReady || (publication.static_checks_key && !await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key ?? publication.static_checks_key, currentOrigin, !!publication.probe_checks_key))) {
        await store.updateDoc(jobPath, { phase: 'verifying replacement at the current address' });
        // The current address serves this artifact; a stale cached file there gets the same path-scoped refresh as a normal publication.
        if (markerReady) await recoverPublicationCache(args.orgId, jobPath, publication, currentOrigin);
        return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'verifying replacement at the current address');
      }
      const previousPreparations = await preparePreviousHosts(args.orgId, group.id, (frozen.previous_website_hosts ?? []).filter((host: string) => !publication?.redirect_hosts?.includes(host) && host !== domains.desired.media_host), publication.website_host, cloudflare, publication.account_id, publication.project);
      const finished = new Date().toISOString();
      const hosts = { ...domains.desired, website_host: publication.website_host };
      const matchesDesired = samePublicationHosts(savedDomains.desired, hosts) && sameRedirectHosts(savedDomains.desired, hosts);
      const windowCandidate = validationWindowAllowed(preparation);
      const ready = (!preparation.validation_blocker || windowCandidate) &&
        (preparation.certificate_ready || preparation.has_existing_traffic === false || windowCandidate) && !redirectBlockers.length &&
        (!mediaPreparation || mediaPreparation.certificate_ready || mediaPreparation.has_existing_traffic === false);
      const recorded = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === savedDomains.revision && current.state !== 'distributing', {
        published: { hosts, dns_mode: domains.dns_mode, publication_id: publication.publication_id, job_id: args.jobId },
        ...(matchesDesired ? { media_preparation: mediaPreparation, preparation, state: ready ? 'ready_to_switch' : 'preparing',
          redirect_preparations: redirectPreparations.length ? redirectPreparations : null, previous_host_preparations: previousPreparations,
          candidate: { source_publication_id: publication.source_publication_id ?? null, id: publication.publication_id, revision: publication.domain_revision, commit: publication.commit,
            deployment_id: deployment.id, sitewide_noindex: frozen.settings?.sitewide_noindex === true, robots_blocked: frozen.robots_blocked === true, verified_at: finished, job_id: args.jobId } } : {}),
        cutover_approved_revision: null, approved_preparation: null, approved_media_preparation: null, approved_redirect_preparations: null, approved_previous_host_preparations: null, approved_validation_window: null,
      });
      if (!recorded) throw new ConnectionError('Domain settings changed while publishing. Refresh the domain status before switching traffic.', 409, 'domain_revision_conflict');
      await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
      await store.updateDoc(paths.version(args.orgId, args.siteId, args.versionId), { last_deployed_at: finished, last_deployed_content_at: publication.content_cutoff, deploy_url: `https://${currentHost}` });
      if (savedDomains.candidate?.job_id && savedDomains.candidate.job_id !== args.jobId) await store.compareAndUpdateDoc<any>(paths.deploy(args.orgId, args.siteId, savedDomains.candidate.job_id),
        previous => previous.status === 'running' && previous.phase === 'awaiting domain cutover approval',
        { status: 'succeeded', phase: 'replaced by newer publication', finished_at: finished });
      await store.updateDoc(jobPath, { phase: matchesDesired ? 'awaiting domain cutover approval' : 'published at current address', deploy_url: `https://${currentHost}`,
        dns_requirements: requirements, validation_blocker: windowCandidate ? preparation.validation_blocker : null,
        ...(!matchesDesired ? { status: 'succeeded', finished_at: finished } : {}) });
      terminal = !matchesDesired;
      parkedCandidate = matchesDesired;
      return 'ran';
    }
    if (preparingDomain && !publication.traffic_applied) await armDomainCutover(args.orgId, args.siteId, group.id, domains);
    const approvedRedirects = preparingDomain && !publication.traffic_applied && domains.cutover_approved_revision === domains.revision && domains.dns_mode === 'automatic'
      ? (domains.approved_redirect_preparations ?? []).filter(item => item.zone_id) : [];
    const redirectDns = new Map<string, Awaited<ReturnType<typeof hostingDns>>>();
    // Rules first: they do nothing until a record is proxied, and a missing permission stops here before any traffic changes.
    for (const approved of approvedRedirects) {
      const access = await hostingDns(args.orgId, group.id, approved.hostname);
      redirectDns.set(approved.hostname, access);
      await ensureApprovedRedirectRule(journaledDomainProvider(access.provider, args.orgId, args.siteId, publication.publication_id, approved.hostname), approved);
      await recordDomainCutover(args.orgId, args.siteId, publication.publication_id, approved.hostname);
    }
    if (preparingDomain && !publication.traffic_applied && domains.cutover_approved_revision === domains.revision && domains.approved_preparation && domains.dns_mode === 'automatic') {
      await applyPreparedTraffic(journaledDomainProvider(dns!.provider, args.orgId, args.siteId, publication.publication_id, domains.approved_preparation.hostname), domains.approved_preparation, { acceptValidationWindow: domains.approved_validation_window === true });
      await recordDomainCutover(args.orgId, args.siteId, publication.publication_id, domains.approved_preparation.hostname);
    }
    if (preparingDomain && !publication.traffic_applied && domains.cutover_approved_revision === domains.revision && domains.approved_media_preparation && mediaDns) {
      await applyPreparedTraffic(journaledDomainProvider(mediaDns.provider, args.orgId, args.siteId, publication.publication_id, domains.approved_media_preparation.hostname), domains.approved_media_preparation);
      await recordDomainCutover(args.orgId, args.siteId, publication.publication_id, domains.approved_media_preparation.hostname);
    }
    for (const approved of approvedRedirects) {
      await applyRedirectTraffic(journaledDomainProvider(redirectDns.get(approved.hostname)!.provider, args.orgId, args.siteId, publication.publication_id, approved.hostname), approved);
      await recordDomainCutover(args.orgId, args.siteId, publication.publication_id, approved.hostname);
    }
    if (!publication.traffic_applied) {
      publication = { ...publication, traffic_applied: true };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    {
      const purgedHosts = publication.cache_purged_deployment === deployment.id ? publication.cache_purged_hosts ?? [] : [];
      const targets = [
        ...(dns && preparation.certificate_ready && preparation.zone_id ? [{ provider: dns.provider, zoneId: preparation.zone_id, host: publication.website_host }] : []),
        ...(mediaDns && mediaPreparation?.certificate_ready && mediaPreparation.zone_id ? [{ provider: mediaDns.provider, zoneId: mediaPreparation.zone_id, host: mediaPreparation.hostname }] : []),
      ];
      for (const target of targets) {
        if (purgedHosts.includes(target.host)) continue;
        if (!await purgePublicationHost(target.provider, target.zoneId, target.host)) {
          await store.updateDoc(jobPath, { phase: 'waiting for Cloudflare cache refresh' });
          return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
        }
        purgedHosts.push(target.host);
        publication = { ...publication, cache_purged_deployment: deployment.id, cache_purged_hosts: purgedHosts };
        await store.updateDoc(jobPath, { git_publication: publication });
      }
    }
    if (mediaPreparation && !await probePublication(`https://${mediaPreparation.hostname}`, '/.well-known/typeroll/publication.json', publication.publication_id)) {
      await store.updateDoc(jobPath, { phase: 'distributing media', dns_requirements: mediaPreparation.requirements });
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    // A reachable pages.dev build is evidence, not the customer's public URL.
    if (!await probePublication(`https://${publication.website_host}`, '/.well-known/typeroll/publication.json', publication.publication_id, { observe: async result => {
      await store.updateDoc(jobPath, { public_probe: result });
      if (!result.ready) console.info(JSON.stringify({ event: 'customer_publication_pending', site_id: args.siteId, job_id: args.jobId, ...result }));
    } })) {
      const validationWindow = domains.approved_validation_window === true && domains.cutover_approved_revision === domains.revision && !preparation.certificate_ready;
      const restore = (domains.approved_preparation?.previous_records ?? []).map(record => `${record.type} ${record.name} ${record.content} (${record.proxied ? 'proxied' : 'DNS only'})`).join(', ');
      await store.updateDoc(jobPath, { phase: validationWindow ? `waiting for Cloudflare to validate ${publication.website_host} after the approved switch` : preparation.action === 'verify' ? 'distributing' : 'awaiting domain setup', dns_requirements: preparation.requirements,
        ...(validationWindow ? { verification_message: `${publication.website_host} now points at Cloudflare Pages and does not answer until Cloudflare validates it. If it is not live within ${domains.validation_timeout_minutes ?? 15} minutes of the traffic switch, Typeroll restores the saved records unless they have been edited since. Previous destination: ${restore || 'no previous record'}. Public verification will retry automatically.` } : {}) });
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    if (publication.static_checks_key) {
      for (const origin of [...new Set([`https://${publication.website_host}`, ...(mediaPreparation ? [`https://${mediaPreparation.hostname}`] : [])])]) {
        if (!await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key ?? publication.static_checks_key, origin, !!publication.probe_checks_key)) {
          await store.updateDoc(jobPath, { phase: 'waiting for updated static files' });
          await recoverPublicationCache(args.orgId, jobPath, publication, origin, origin === `https://${publication.website_host}` ? dns : mediaDns);
          return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
        }
      }
    }
    if (await pendingRedirect(jobPath, publication, redirectPreparations)) return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    return await finishPublication(publication, domains, frozen);
  } catch (error) {
    const target = await store.getDoc<Target>(targetPath);
    if (leaseLost || target?.lease_id !== lease || target.lease_until <= Date.now()) return 'deferred';
    const failedJob = await store.getDoc<GitJob>(jobPath);
    const transportCode = (error as any)?.code;
    const temporary = error instanceof ProviderTransportError ||
      (error instanceof ProviderError && (error.status === 429 || error.status >= 500)) ||
      [4, 8, 10, 13, 14, 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(transportCode);
    if (temporary && (failedJob?.coordinator_retries ?? 0) < 5) {
      await assertLease();
      await store.updateDoc(jobPath, { coordinator_retries: (failedJob?.coordinator_retries ?? 0) + 1 });
      console.info(JSON.stringify({ event: 'publication_retry', job_id: args.jobId, phase: failedJob?.phase, code: error instanceof ProviderTransportError ? error.code : 'publication_service_unavailable' }));
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    if (failedJob?.git_publication?.build_task_key) {
      const failedTask = await store.getDoc<BuildTask>(`${buildTasksPath(args.orgId)}/${failedJob.git_publication.build_task_key}`);
      if (failedTask?.seo_report) await store.updateDoc(jobPath, { seo_report: failedTask.seo_report });
    }
    const failure = { stage: failedJob?.phase ?? 'connecting publishing accounts',
      code: error instanceof DerivationError ? 'publication_derivation_failed' : error instanceof ProviderTransportError ? error.code : error instanceof ConnectionError ? error.code : error instanceof ProviderError ? 'provider_request_failed' : 'publication_internal_error',
      ...(error instanceof DerivationError ? { provider: error.provider } : {}),
      ...(error instanceof ProviderError ? { provider: error.provider, http_status: error.status, provider_codes: error.codes, provider_reason: error.reason, provider_operation: error.operation, provider_error_types: error.errorTypes } : {}),
      ...(error instanceof ConnectionError && error.details?.build_diagnostic ? { diagnostic: error.details.build_diagnostic } : {}),
      ...(failedJob?.git_publication ? { hosting_group_id: failedJob.git_publication.hosting_group_id ?? 'default', hosting_account_id: failedJob.git_publication.account_id, project: failedJob.git_publication.project } : {}) };
    console.error(JSON.stringify({ event: 'customer_publication_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId, ...failure }));
    const message = error instanceof ProviderError && error.provider === 'Cloudflare' && failure.stage === 'creating Cloudflare Pages project'
      ? projectCreationMessage(error, failedJob?.git_publication)
      : error instanceof DerivationError ? `An app could not prepare publication data (${error.provider}). ${error.message} The live site has not changed.`
      : error instanceof ConnectionError ? error.message : error instanceof ProviderError
      ? `${error.provider} returned HTTP ${error.status}${error.codes.length ? ` (code ${error.codes.join(', ')})` : ''} during ${failure.stage}. ${githubFailureHint(error) || 'Open Publishing to check the connection and retry.'}${providerRequestNote(error)}`
      : `Publishing stopped during ${failure.stage}. Retry the deployment. If it fails again, contact support with deployment ${args.jobId}.`;
    let rollbackMessage = '';
    if (failedJob?.git_publication) {
      const cutover = await readDomainCutover(args.orgId, args.siteId, failedJob.git_publication.publication_id);
      if (cutover?.state === 'armed') {
        const rollback = await rollbackDomainCutover(args.orgId, args.siteId, failedJob.git_publication.publication_id);
        rollbackMessage = rollback?.state === 'rolled_back' ? ' Previous DNS was restored automatically.' : ` Automatic rollback needs attention: ${rollback?.errors.join(' ')}`;
      }
    }
    const failedBuild = (await store.getDoc<GitJob>(jobPath))?.git_publication?.build_task_key;
    if (failedBuild) await new OrganizationBuildQueue().cancel(args.orgId, failedBuild);
    await store.updateDoc(jobPath, { status: 'failed', phase: 'failed', finished_at: new Date().toISOString(),
      error: message + rollbackMessage, verification_message: failedJob?.verification_message ? message : null, failure });
    terminal = true;
    return 'ran';
  } finally {
    clearInterval(heartbeat);
    await renewal.catch(() => {});
    try { await recordCustomerCompute(args.orgId, args.siteId, args.jobId, performance.now() - attemptStarted); }
    catch { console.error(JSON.stringify({ event: 'customer_publication_cost_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId })); }
    if (terminal) await releaseBuildAccess();
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease,
      { lease_id: null, lease_until: 0, ...(terminal || parkedCandidate ? { job_id: null } : {}) });
    if (terminal || parkedCandidate) {
      const { wakePendingSite } = await import('../scheduling/worker');
      await wakePendingSite(args.orgId, args.siteId);
    }
  }
}

/** Name the failed provider call and its error types (no ids, paths or provider text) for support. */
function providerRequestNote(error: ProviderError): string {
  if (!error.operation) return '';
  const types = error.errorTypes.map(type => [type.resource, type.code, type.field].filter(Boolean).join(' ')).filter(Boolean);
  return ` Request: ${error.operation}${types.length ? `; ${types.join(', ')}` : ''}.`;
}
