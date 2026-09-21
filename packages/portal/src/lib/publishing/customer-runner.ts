import { assertVerificationRetry } from './verification-retry';
import { MEDIA_VARIANT_SLOTS, mediaVariantSuffix } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';
import { schedulePublication, waitForBuild, waitForPublicationCondition } from '../scheduling/continuation';
import { mapPublicationParts } from './parallel';
import { ensureGithubMainBranch } from './providers.mjs';
import { createGithubRepository } from './github-user';
import { verifyManagedProject } from './managed-migration';
import { capturePublicationImpact } from './impact-preview';
import { compareImpact } from './impact';
import { readSnapshot, saveSnapshot } from './publication-snapshot';
import { siteHostingGroup, lockSiteHostingGroup } from './hosting-groups';
import { hostingDns } from './hosting-dns';
import { purgePublicationHost } from './publication-cache';
import { randomUUID } from 'node:crypto';
import { paths, CORE_BLOCK_TYPES, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { githubConfiguration } from './github-connection';
import { cloudflareClient } from './cloudflare-oauth';
import { githubInstallationClient, publishTree, pagesProjectBody, matchingDeployment, findPublicationDeployment, setPagesBuildMediaAccess, assertSuccessfulStaticDeployment, digest, ProviderError, ProviderTransportError } from './providers.mjs';
import { getSiteDomains, samePublicationHosts, getOrganizationDomains, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { resolvePublicationVersion } from './publication-version';
import { assertPublishingReady } from './readiness';
import { publicationSourceTree } from './source-tree';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { probePublication } from '../deploy/availability';
import type { EnqueueArgs, DeployRunOutcome } from '../deploy/queue';
import { preparePagesDomain, applyPreparedTraffic } from './domain-provider';
import { retainDistinctMediaManifests, publicationMediaManifest } from './media-manifest';
import { customerBuildMediaAccess } from './r2-build-credentials';
import { publicationRuntime } from './runtime-projection';
import { preparePublicMediaDomains } from './media-domain';
import { recordPublishingOrigin } from './runtime-origins';
import { retargetWebsite } from './publication-retarget';
import { recordCustomerCompute } from './compute-cost';
import { readEngineConfiguration, type BuildProvider } from '../builds/state';
import { selectedBuildProvider } from '../builds/selection';
import { enqueueBuild, completedBuild } from '../builds/jobs';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from '../builds/queue';
import { uploadStaticBuild, finalizeDirectUpload } from '../builds/upload';
import { prepareStaticProject, saveStaticChecks, verifyStaticBatch, saveCustomerVerification, verifyCustomerCandidate, type CustomerVerification } from '../builds/publication';

interface GitPublication extends CustomerVerification {
  candidate_verified_id?: string | null; deployment_receipt?: any; project_prepared?: boolean; website_preparation?: import('./domain-provider').DomainPreparation | null; media_preparation?: import('./domain-provider').DomainPreparation | null; public_media_prepared?: boolean; traffic_applied?: boolean;
  build_provider?: BuildProvider; build_engine_revision?: string; build_task_key?: string | null; static_checks_key?: string | null;
  hosting_group_id?: string; hosting_group_revision?: string;
  owner: string; repo: string; project: string; account_id: string; branch: string;
  publication_id: string; snapshot_chunks: number; snapshot_digest: string; snapshot_format?: 1; content_cutoff: string;
  domain_revision: string; website_host: string; commit?: string | null; deployment_id?: string | null;
  release_branch?: 'main' | null; snapshot_job_id?: string; cache_purged_deployment?: string; cache_purged_hosts?: string[];
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

interface Target { job_id: string | null; lease_id: string | null; lease_until: number; last_publication?: GitPublication }
export type GitJob = DeployJob & { failure?: { code: string; stage?: string } | null; verification_retry?: { request_id: string; requested_at: string; failure: any }; coordinator_retries?: number; observation_started_at?: string; git_publication?: GitPublication; publication_intent?: 'domain_prepare'; domain_revision?: string; source_publication?: GitPublication };
/** One bounded queue attempt. Build waiting is durable queue backoff, never a sleeping Astro process. */
export async function executeCustomerPublication(args: EnqueueArgs): Promise<DeployRunOutcome> {
  const attemptStarted = performance.now();
  const store = getStore();
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  const job = await store.getDoc<GitJob>(jobPath);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return 'ran';
  if (job.phase === 'awaiting domain cutover approval') {
    const domains = await getSiteDomains(args.orgId, args.siteId);
    if (domains.cutover_approved_revision !== job.git_publication?.domain_revision) return 'ran';
  }
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
    { job_id: args.jobId, lease_id: lease, lease_until: Date.now() + 300_000 });
  if (!acquired) return 'deferred';
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
  const releaseBuildAccess = async () => {
    for (const environment of ['production', 'preview']) await store.compareAndUpdateDoc<any>(`${paths.site(args.orgId, args.siteId)}/publishing_build_slots/${environment}`, value => value.job_id === args.jobId, { job_id: null });
  };
  const finishPublication = async (publication: GitPublication, domains: DomainConfiguration, frozen: any): Promise<DeployRunOutcome> => {
    await recordPublishingOrigin(args.orgId, args.siteId, `https://${publication.website_host}`);
    const finished = new Date().toISOString();
    const stillOwned = await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + 60_000 });
    if (!stillOwned) return 'deferred';
    await store.updateDoc(paths.version(args.orgId, args.siteId, args.versionId), { last_deployed_at: finished, last_deployed_content_at: publication.content_cutoff, deploy_url: `https://${publication.website_host}` });
    if (args.versionId === 'main') {
      await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === publication!.domain_revision,
        { active: { ...domains.desired, website_host: publication.website_host }, state: 'live',
          media_aliases: [...domains.media_aliases, ...(domains.active && !domains.media_aliases.some(alias => samePublicationHosts(alias, domains.active!)) ? [domains.active] : [])] });
      await store.updateDoc(paths.site(args.orgId, args.siteId), { domain: publication.website_host, domain_status: 'live', domain_verified_at: finished });
    }
    await mapPublicationParts<any, void>(frozen.media_manifest?.entries ?? [], async entry => {
      const mediaPath = `${paths.media(args.orgId, args.siteId)}/${entry.id}`;
      const aliases = [entry.cdn_url, ...entry.aliases.map((alias: any) => alias.url)];
      for (const slot of MEDIA_VARIANT_SLOTS) for (const format of ['webp', 'avif']) aliases.push(entry.cdn_url + mediaVariantSuffix(slot, entry.sha256, format));
      const record = await store.getDoc<any>(mediaPath);
      if (record && aliases.some(alias => !(record.source_aliases ?? []).includes(alias))) await store.compareAndUpdateDoc<any>(mediaPath, current => current.sha256 === entry.sha256 && JSON.stringify(current.source_aliases) === JSON.stringify(record.source_aliases),
        { source_aliases: [...new Set([...(record.source_aliases ?? []), ...aliases])] });
    });
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
    await assertLease();
    await store.updateDoc(jobPath, { status: 'succeeded', phase: 'live', deploy_url: `https://${publication.website_host}`, verification_message: null, static_probe: null, finished_at: finished });
    terminal = true;
    return 'ran';
  };
  try {
    await store.updateDoc(jobPath, { coordinator_observed_at: new Date().toISOString() });
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
    const [gitConnection, cfConnection, domains, organization, site] = await Promise.all([
      getConnection(args.orgId, 'github'), getConnection(args.orgId, 'cloudflare', group.id), getSiteDomains(args.orgId, args.siteId),
      getOrganizationDomains(args.orgId), store.getDoc<Site>(paths.site(args.orgId, args.siteId)),
    ]);
    const identity = gitConnection.github!;
    let publication = job.git_publication;
    // Older Firestore updates merged omitted nested fields, retaining the preview commit.
    // Resume that frozen candidate instead of waiting for a main build that was never pushed.
    if (!job.verification_retry && publication?.branch === 'main' && publication.release_branch === 'main') {
      publication = { ...publication, commit: null, deployment_id: null, release_branch: null, build_task_key: null, static_checks_key: null, verification_task_key: null, verification_checks_key: null, probe_checks_key: null, static_controls_sha256: null, candidate_verified_id: null, deployment_receipt: null, website_preparation: null, media_preparation: null, traffic_applied: false };
      await store.updateDoc(jobPath, { git_publication: publication, phase: 'promoting verified source' });
    }
    if (!publication) {
      await store.updateDoc(jobPath, { status: 'running', phase: 'freezing source', execution_backend: 'customer_git' });
      if (job.publication_intent === 'domain_prepare' && job.domain_revision !== domains.revision) throw new ConnectionError('Domain settings changed. Prepare a new candidate.', 409);
      const priorPublication = job.source_publication ?? acquired.last_publication;
      const prior = priorPublication?.snapshot_job_id ? await readSnapshot({ ...args, jobId: priorPublication.snapshot_job_id }, priorPublication) : null;
      const contentCutoff = job.publication_intent === 'domain_prepare' ? priorPublication!.content_cutoff : new Date().toISOString();
      const prefix = digest(`${args.orgId}\0${args.siteId}`).slice(0, 16);
      const host = args.versionId === 'main' && domains.desired.website_host ||
        `${args.versionId === 'main' ? '' : `v-${digest(args.versionId).slice(0, 8)}-`}site-${prefix}.${group.sites_domain}`;
      let frozen: Record<string, any>;
      if (job.publication_intent === 'domain_prepare') {
        if (!prior) throw new ConnectionError('The last public snapshot is missing. Publish the site before preparing domains.', 409);
        frozen = structuredClone(prior);
        frozen.robots_blocked = args.versionId !== 'main' || !domains.desired.website_host;
        frozen.settings.sitewide_noindex = frozen.robots_blocked || frozen.authored_noindex === true;
      } else {
        const resolved = await resolvePublicationVersion(args.orgId, args.siteId, args.versionId);
        const publicRuntime = await publicationRuntime(args.orgId, args.siteId);
        frozen = projectStaticPublication({ ...resolved, site: { ...site, domain: host }, media: [], forms: publicRuntime.forms, extensions: publicRuntime.extensions.installations, publicRuntime }, {
          siteUrl: `https://${host}`, coreCommit: process.env.TYPEROLL_SOURCE_SHA ?? '', publishedAt: contentCutoff,
          noindex: args.versionId !== 'main' || !domains.desired.website_host, coreBlockTypes: CORE_BLOCK_TYPES,
        });
        frozen.authored_noindex = resolved.settings?.sitewide_noindex === true;
      }
      // Media originals and metadata for a domain-only build come from the public snapshot too.
      const deferReferences = job.publication_intent !== 'domain_prepare' || Boolean(prior?.reference_mapping);
      const mapped = await publicationMediaManifest(args.orgId, args.siteId, frozen, host, job.publication_intent === 'domain_prepare' ? prior : undefined, { deferReferences });
      // Compare the exact media records frozen into the manifest, without a second datastore read.
      const impactSnapshot = job.publication_intent === 'domain_prepare' ? null : await capturePublicationImpact(frozen, args.orgId, args.siteId, domains, organization, mapped.sourceMedia);
      const previousOrigins = [site?.domain ? `https://${site.domain}` : '', prior?.site_url ?? '', ...(prior?.reference_mapping?.website_origins ?? [])].filter(Boolean);
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
      frozen.retained_media_manifests = retainDistinctMediaManifests(retained, frozen.media_manifest);
      // Content identity excludes wall-clock metadata so an unchanged publication can reuse the previous build.
      const stable = { ...frozen, published_at: undefined, publication_id: undefined };
      frozen.publication_id = digest(JSON.stringify(stable));
      if (args.dryRun) {
        await publicationSourceTree(frozen);
        await store.updateDoc(jobPath, { status: 'succeeded', phase: 'source verified (dry-run, no Git push)', dry_run: true, finished_at: contentCutoff });
        terminal = true; return 'ran';
      }
      if (acquired.last_publication?.publication_id === frozen.publication_id &&
          await probePublication(`https://${host}`, '/.well-known/typeroll/publication.json', frozen.publication_id)) {
        await store.updateDoc(jobPath, { status: 'succeeded', phase: 'unchanged', finished_at: contentCutoff, deploy_url: `https://${host}` });
        terminal = true; return 'ran';
      }
      publication = { hosting_group_id: group.id, hosting_group_revision: group.revision, owner: identity.owner, repo: `typeroll-${prefix}`, project: site?.publishing_migration?.project ?? `typeroll-${prefix}`, account_id: cfConnection.cloudflare!.account_id,
        branch: frozen.git_branch, publication_id: frozen.publication_id, content_cutoff: contentCutoff,
        domain_revision: domains.revision, website_host: host, snapshot_job_id: args.jobId, ...await saveSnapshot(args, frozen) };
      const selectedProvider = await selectedBuildProvider(args.orgId);
      const engine = await readEngineConfiguration(args.orgId, selectedProvider);
      if (site?.publishing_migration && engine?.status !== 'ready') throw new ConnectionError('Restore the shared build engine before publishing this migrated site.', 409, 'shared_build_setup_required');
      if (selectedProvider === 'github' && !engine) throw new ConnectionError('Finish build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
      if (engine && engine.status !== 'ready') throw new ConnectionError('Finish shared build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
      if (engine?.status === 'ready') { publication.build_engine_revision = engine.revision; publication.build_provider = engine.provider ?? 'cloudflare'; }
      if (args.versionId === 'main' && domains.active && !samePublicationHosts(domains.active, { ...domains.desired, website_host: host })) {
        publication.branch = `version-domain-${domains.revision.replaceAll('-', '').slice(0, 16)}`;
        publication.release_branch = 'main';
      }
      await assertLease();
      await store.updateDoc(jobPath, { git_publication: publication });
      return await checkpoint('source frozen');
    }
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
    if ((publication.hosting_group_id ?? 'default') !== group.id || (publication.hosting_group_revision && publication.hosting_group_revision !== group.revision) || publication.account_id !== cfConnection.cloudflare?.account_id || publication.owner !== identity.owner || publication.domain_revision !== domains.revision) {
      throw new ConnectionError('Publishing accounts or domain settings changed. Start a new deployment.', 409);
    }
    if (job.verification_retry) {
      // This path can only verify and record an already-served artifact. It does
      // not enter source generation, build dispatch, upload or DNS preparation.
      const frozen = await readSnapshot(args, publication);
      const mediaHost = frozen.media_manifest?.delivery === 'static' ? frozen.media_manifest.media_host : null;
      const origins = [...new Set([`https://${publication.website_host}`, ...(mediaHost ? [`https://${mediaHost}`] : [])])];
      for (const origin of origins) {
        if (!await probePublication(origin, '/.well-known/typeroll/publication.json', publication.publication_id) ||
            !await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key!, origin, true)) {
          await store.updateDoc(jobPath, { phase: 'retrying public verification' });
          return await waitForPublicationCondition(jobPath, 'retrying public verification');
        }
      }
      await assertLease();
      return await finishPublication(publication, domains, frozen);
    }
    const projectRoot = `/accounts/${publication.account_id}/pages/projects/${publication.project}`;
    if (!publication.commit) {
      const frozen = await readSnapshot(args, publication);
      const files = await publicationSourceTree(frozen);
      const repoRoot = `/repos/${publication.owner}/${publication.repo}`;
      let repository = await github(repoRoot, { missing: true });
      if (!repository) {
        await createGithubRepository(args.orgId, github, identity, {
          name: publication.repo, private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false,
          description: `Generated Typeroll site ${digest(`${args.orgId}\0${args.siteId}`).slice(0, 16)}`,
        });
        repository = await github(repoRoot);
      }
      if (repository.private !== true || String(repository.owner?.id) !== identity.account_id || repository.archived || repository.description !== `Generated Typeroll site ${digest(`${args.orgId}\0${args.siteId}`).slice(0, 16)}`) {
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
      if (!await probePublication(candidate.origin, '/.well-known/typeroll/publication.json', publication.publication_id)) return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
      if (publication.verification_checks_key && !await verifyCustomerCandidate(args.orgId, jobPath, publication, candidate.origin)) {
        await store.updateDoc(jobPath, { phase: 'verifying static output on the organization build engine' }); return await waitForBuild(jobPath, args.orgId, publication.verification_task_key!);
      }
      if (publication.static_checks_key && !await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key ?? publication.static_checks_key, candidate.origin, !!publication.probe_checks_key)) {
        await store.updateDoc(jobPath, { phase: 'verifying static output' }); return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
      }
      publication = { ...publication, candidate_verified_id: deployment.id,
        deployment_receipt: { id: deployment.id, url: deployment.url, uses_functions: false, latest_stage: deployment.latest_stage, deployment_trigger: deployment.deployment_trigger } };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
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
      branch: publication.release_branch ?? publication.branch, hostname: publication.website_host,
      configureTraffic: !publication.release_branch, dnsProvider: dns?.provider, dnsAccountId: dns?.accountId,
      dnsMode });
    let mediaPreparation: import('./domain-provider').DomainPreparation | null = null;
    let mediaDns: Awaited<ReturnType<typeof hostingDns>> | null = null;
    const mediaManifest = frozen.media_manifest;
    if (mediaManifest?.delivery === 'static' && mediaManifest.media_host !== publication.website_host) {
      mediaDns = domains.dns_mode === 'automatic' ? await hostingDns(args.orgId, group.id, mediaManifest.media_host) : null;
      mediaPreparation = publication.media_preparation ?? await preparePagesDomain(cloudflare, { accountId: publication.account_id, project: publication.project,
        branch: publication.release_branch ?? publication.branch, hostname: mediaManifest.media_host, dnsMode: domains.dns_mode,
        dnsProvider: mediaDns?.provider, dnsAccountId: mediaDns?.accountId, configureTraffic: !publication.release_branch });
    }
    if (preparation.action === 'verify' && preparation.certificate_ready) {
      publication = { ...publication, website_preparation: preparation, ...(mediaPreparation?.action === 'verify' && mediaPreparation.certificate_ready ? { media_preparation: mediaPreparation } : {}) };
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    if (args.versionId === 'main') await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === publication!.domain_revision,
      { media_preparation: mediaPreparation, state: preparation.action === 'complete_validation' ? 'preparing' : 'ready_to_switch', preparation,
        candidate: { id: publication.publication_id, revision: publication.domain_revision, commit: publication.commit,
        deployment_id: deployment.id, verified_at: new Date().toISOString(), job_id: args.jobId } });
    if (publication.release_branch) {
      const blocker = preparation.validation_blocker ?? mediaPreparation?.validation_blocker;
      if (blocker) throw new ConnectionError(blocker.message, 409, blocker.code);
      if (domains.cutover_approved_revision !== domains.revision) {
        if ((!preparation.certificate_ready && preparation.has_existing_traffic !== false) || (mediaPreparation && !mediaPreparation.certificate_ready && mediaPreparation.has_existing_traffic !== false)) {
          await store.updateDoc(jobPath, { phase: 'waiting for domain validation', dns_requirements: preparation.requirements });
          return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
        }
        await store.updateDoc(jobPath, { phase: 'awaiting domain cutover approval', dns_requirements: preparation.requirements });
        // Human approval can take days. Consume this observation task; approval queues a continuation.
        return 'ran';
      }
      // Explicit nulls replace nested Firestore fields; omission leaves old values merged in.
      publication = { ...publication, branch: 'main', commit: null, deployment_id: null, release_branch: null, build_task_key: null, static_checks_key: null, verification_task_key: null, verification_checks_key: null, probe_checks_key: null, static_controls_sha256: null, candidate_verified_id: null, deployment_receipt: null, website_preparation: null, media_preparation: null, traffic_applied: false };
      await store.updateDoc(jobPath, { git_publication: publication, phase: 'promoting verified source' });
      return await schedulePublication(jobPath, 'domain_source_promoted');
    }
    if (!publication.traffic_applied && domains.cutover_approved_revision === domains.revision && domains.approved_preparation && domains.dns_mode === 'automatic') {
      await applyPreparedTraffic(dns!.provider, domains.approved_preparation);
    }
    if (!publication.traffic_applied && domains.cutover_approved_revision === domains.revision && domains.approved_media_preparation && mediaDns) {
      await applyPreparedTraffic(mediaDns.provider, domains.approved_media_preparation);
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
      await store.updateDoc(jobPath, { phase: preparation.action === 'verify' ? 'distributing' : 'awaiting domain setup', dns_requirements: preparation.requirements });
      return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
    }
    if (publication.static_checks_key) {
      for (const origin of [...new Set([`https://${publication.website_host}`, ...(mediaPreparation ? [`https://${mediaPreparation.hostname}`] : [])])]) {
        if (!await verifyStaticBatch(args.orgId, jobPath, publication.probe_checks_key ?? publication.static_checks_key, origin, !!publication.probe_checks_key)) {
          await store.updateDoc(jobPath, { phase: 'waiting for updated static files' }); return await waitForPublicationCondition(jobPath, (await store.getDoc<GitJob>(jobPath))?.phase ?? 'provider');
        }
      }
    }
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
      code: error instanceof ProviderTransportError ? error.code : error instanceof ConnectionError ? error.code : error instanceof ProviderError ? 'provider_request_failed' : 'publication_internal_error',
      ...(error instanceof ProviderError ? { provider: error.provider, http_status: error.status, provider_codes: error.codes } : {}),
      ...(failedJob?.git_publication ? { hosting_group_id: failedJob.git_publication.hosting_group_id ?? 'default', hosting_account_id: failedJob.git_publication.account_id, project: failedJob.git_publication.project } : {}) };
    console.error(JSON.stringify({ event: 'customer_publication_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId, ...failure }));
    const message = error instanceof ProviderError && error.provider === 'Cloudflare' && failure.stage === 'creating Cloudflare Pages project'
      ? projectCreationMessage(error, failedJob?.git_publication)
      : error instanceof ConnectionError ? error.message : error instanceof ProviderError
      ? `${error.provider} returned HTTP ${error.status}${error.codes.length ? ` (code ${error.codes.join(', ')})` : ''} during ${failure.stage}. Open Publishing to check the connection and retry.`
      : `Publishing stopped during ${failure.stage}. Retry the deployment. If it fails again, contact support with deployment ${args.jobId}.`;
    const failedBuild = (await store.getDoc<GitJob>(jobPath))?.git_publication?.build_task_key;
    if (failedBuild) await new OrganizationBuildQueue().cancel(args.orgId, failedBuild);
    await store.updateDoc(jobPath, { status: 'failed', phase: 'failed', finished_at: new Date().toISOString(),
      error: message, verification_message: failedJob?.verification_message ? message : null, failure });
    terminal = true;
    return 'ran';
  } finally {
    clearInterval(heartbeat);
    await renewal.catch(() => {});
    try { await recordCustomerCompute(args.orgId, args.siteId, args.jobId, performance.now() - attemptStarted); }
    catch { console.error(JSON.stringify({ event: 'customer_publication_cost_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId })); }
    if (terminal) await releaseBuildAccess();
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease,
      { lease_id: null, lease_until: 0, ...(terminal ? { job_id: null } : {}) });
    if (terminal) {
      const { wakePendingSite } = await import('../scheduling/worker');
      await wakePendingSite(args.orgId, args.siteId);
    }
  }
}
