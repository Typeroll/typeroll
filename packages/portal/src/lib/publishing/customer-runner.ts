import { randomUUID } from 'node:crypto';
import { paths, CORE_BLOCK_TYPES, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { githubConfiguration } from './github-connection';
import { cloudflareClient } from './cloudflare-oauth';
import { githubInstallationClient, publishTree, pagesProjectBody, matchingDeployment, findPublicationDeployment, setPagesBuildMediaAccess, assertSuccessfulStaticDeployment, digest, ProviderError } from './providers.mjs';
import { getSiteDomains, getOrganizationDomains, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { resolvePublicationVersion } from './publication-version';
import { assertPublishingReady } from './readiness';
import { publicationSourceTree } from './source-tree';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { probePublication } from '../deploy/availability';
import type { EnqueueArgs, DeployRunOutcome } from '../deploy/queue';
import { preparePagesDomain, applyPreparedTraffic } from './domain-provider';
import { publicationMediaManifest } from './media-manifest';
import { customerBuildMediaAccess } from './r2-build-credentials';
import { publicationRuntime } from './runtime-projection';
import { preparePublicMediaDomains } from './media-domain';
import { recordPublishingOrigin } from './runtime-origins';
import { retargetWebsite } from './publication-retarget';
import { recordCustomerCompute } from './compute-cost';

interface GitPublication {
  owner: string; repo: string; project: string; account_id: string; branch: string;
  publication_id: string; snapshot_chunks: number; snapshot_digest: string; content_cutoff: string;
  domain_revision: string; website_host: string; commit?: string; deployment_id?: string;
  release_branch?: 'main'; snapshot_job_id?: string;
}
interface Target { job_id: string | null; lease_id: string | null; lease_until: number; last_publication?: GitPublication }
type GitJob = DeployJob & { git_publication?: GitPublication; publication_intent?: 'domain_prepare'; domain_revision?: string; source_publication?: GitPublication };
const snapshotPath = (args: EnqueueArgs) => `${paths.deploy(args.orgId, args.siteId, args.jobId)}/snapshot_chunks`;

async function saveSnapshot(args: EnqueueArgs, value: unknown) {
  const serialized = JSON.stringify(value);
  const chunks = Math.ceil(serialized.length / 120_000);
  if (chunks > 250) throw new ConnectionError('The publication is too large. Reduce generated content before publishing.', 413);
  for (let i = 0; i < chunks; i++) await getStore().setDoc(`${snapshotPath(args)}/${String(i).padStart(4, '0')}`, { data: serialized.slice(i * 120_000, (i + 1) * 120_000) });
  return { snapshot_chunks: chunks, snapshot_digest: digest(serialized) };
}

async function readSnapshot(args: EnqueueArgs, publication: GitPublication) {
  let serialized = '';
  for (let i = 0; i < publication.snapshot_chunks; i++) {
    const chunk = await getStore().getDoc<{ data: string }>(`${snapshotPath(args)}/${String(i).padStart(4, '0')}`);
    if (!chunk) throw new Error('Frozen publication is incomplete');
    serialized += chunk.data;
  }
  if (digest(serialized) !== publication.snapshot_digest) throw new Error('Frozen publication failed integrity verification');
  return JSON.parse(serialized);
}

/** One bounded queue attempt. Build waiting is durable queue backoff, never a sleeping Astro process. */
export async function executeCustomerPublication(args: EnqueueArgs): Promise<DeployRunOutcome> {
  const attemptStarted = performance.now();
  const store = getStore();
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  const job = await store.getDoc<GitJob>(jobPath);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return 'ran';
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
  const assertLease = async () => {
    if (!await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + 300_000 })) throw new Error('Publication lease expired');
  };
  let terminal = false;
  const releaseBuildAccess = async () => {
    for (const environment of ['production', 'preview']) await store.compareAndUpdateDoc<any>(`${paths.site(args.orgId, args.siteId)}/publishing_build_slots/${environment}`, value => value.job_id === args.jobId, { job_id: null });
  };
  try {
    if (args.environment === 'staging' && args.versionId === 'main') throw new ConnectionError('Select a site version to publish a test deployment. The main version publishes the live website.', 409, 'publication_version_required');
    await assertPublishingReady(args.orgId, args.siteId, args.versionId);
    const [gitConnection, cfConnection, domains, organization, site] = await Promise.all([
      getConnection(args.orgId, 'github'), getConnection(args.orgId, 'cloudflare'), getSiteDomains(args.orgId, args.siteId),
      getOrganizationDomains(args.orgId), store.getDoc<Site>(paths.site(args.orgId, args.siteId)),
    ]);
    const identity = gitConnection.github!;
    const config = githubConfiguration();
    const github = await githubInstallationClient({ appId: config.appId, installationId: identity.installation_id, owner: identity.owner, privateKey: config.privateKey });
    const cloudflare = await cloudflareClient(args.orgId);
    let publication = job.git_publication;
    if (!publication) {
      await store.updateDoc(jobPath, { status: 'running', phase: 'freezing source', execution_backend: 'customer_git' });
      if (job.publication_intent === 'domain_prepare' && job.domain_revision !== domains.revision) throw new ConnectionError('Domain settings changed. Prepare a new candidate.', 409);
      const priorPublication = job.source_publication ?? acquired.last_publication;
      const prior = priorPublication?.snapshot_job_id ? await readSnapshot({ ...args, jobId: priorPublication.snapshot_job_id }, priorPublication) : null;
      const contentCutoff = job.publication_intent === 'domain_prepare' ? priorPublication!.content_cutoff : new Date().toISOString();
      const prefix = digest(`${args.orgId}\0${args.siteId}`).slice(0, 16);
      const host = args.versionId === 'main' && domains.desired.website_host ||
        `${args.versionId === 'main' ? '' : `v-${digest(args.versionId).slice(0, 8)}-`}site-${prefix}.${organization.sites_domain}`;
      let frozen: Record<string, any>;
      if (job.publication_intent === 'domain_prepare') {
        if (!prior) throw new ConnectionError('The last public snapshot is missing. Publish the site before preparing domains.', 409);
        frozen = structuredClone(prior);
        frozen.settings.sitewide_noindex = !domains.desired.website_host || frozen.authored_noindex === true;
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
      const mapped = await publicationMediaManifest(args.orgId, args.siteId, frozen, host, job.publication_intent === 'domain_prepare' ? prior : undefined);
      frozen = retargetWebsite(mapped.content, [site?.domain ? `https://${site.domain}` : '', prior?.site_url ?? ''], `https://${host}`);
      frozen = { ...frozen, site_url: `https://${host}`, site: { ...frozen.site, domain: host }, media: mapped.media, media_manifest: mapped.manifest };
      const retained = [...(prior?.retained_media_manifests ?? []), ...(prior?.media_manifest?.media_host === prior?.media_manifest?.website_host && prior?.media_manifest ? [prior.media_manifest] : [])];
      frozen.retained_media_manifests = retained.filter((entry, index) => retained.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === index);
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
      publication = { owner: identity.owner, repo: `typeroll-${prefix}`, project: `typeroll-${prefix}`, account_id: cfConnection.cloudflare!.account_id,
        branch: frozen.git_branch, publication_id: frozen.publication_id, content_cutoff: contentCutoff,
        domain_revision: domains.revision, website_host: host, snapshot_job_id: args.jobId, ...await saveSnapshot(args, frozen) };
      if (args.versionId === 'main' && domains.active && JSON.stringify(domains.active) !== JSON.stringify({ ...domains.desired, website_host: host })) {
        publication.branch = `version-domain-${domains.revision.replaceAll('-', '').slice(0, 16)}`;
        publication.release_branch = 'main';
      }
      await store.updateDoc(jobPath, { git_publication: publication });
    }
    if (publication.account_id !== cfConnection.cloudflare?.account_id || publication.owner !== identity.owner || publication.domain_revision !== domains.revision) {
      throw new ConnectionError('Publishing accounts or domain settings changed. Start a new deployment.', 409);
    }
    const projectRoot = `/accounts/${publication.account_id}/pages/projects/${publication.project}`;
    if (!publication.commit) {
      const frozen = await readSnapshot(args, publication);
      const files = await publicationSourceTree(frozen);
      const repoRoot = `/repos/${publication.owner}/${publication.repo}`;
      let repository = await github(repoRoot, { missing: true });
      if (!repository) {
        await github(`/orgs/${publication.owner}/repos`, { method: 'POST', body: {
          name: publication.repo, private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false,
          description: `Generated Typeroll site ${digest(`${args.orgId}\0${args.siteId}`).slice(0, 16)}`,
        } });
        repository = await github(repoRoot);
      }
      if (repository.private !== true || String(repository.owner?.id) !== identity.account_id || repository.default_branch !== 'main' || repository.archived || repository.description !== `Generated Typeroll site ${digest(`${args.orgId}\0${args.siteId}`).slice(0, 16)}`) {
        throw new ConnectionError('The generated repository does not match this organization. Check GitHub publishing access.', 409);
      }
      let connectedProject = await cloudflare(projectRoot, { missing: true });
      if (!connectedProject) {
        try { await cloudflare(`/accounts/${publication.account_id}/pages/projects`, { method: 'POST', body: pagesProjectBody({ owner: publication.owner, repo: publication.repo, repository, project: publication.project }) }); }
        catch { throw new ConnectionError('Cloudflare could not connect the generated repository. In Cloudflare → Workers & Pages → Create application → Pages → Connect to Git → + Add account, authorize Cloudflare’s GitHub App for the same organization with All repositories. Then retry the deployment. Also check your Pages project limit.', 409, 'cloudflare_git_setup_required'); }
        connectedProject = await cloudflare(projectRoot);
      }
      if (connectedProject.source?.type !== 'github' || String(connectedProject.source.config?.repo_id) !== String(repository.id)) throw new ConnectionError('Cloudflare is connected to a different repository.', 409);
      if (frozen.media_manifest?.entries?.length || frozen.retained_media_manifests?.length) {
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
        if (!accessSlot) { await store.updateDoc(jobPath, { phase: 'waiting for the previous version build' }); return 'deferred'; }
        const access = await customerBuildMediaAccess(args.orgId, args.siteId, frozen.media_manifest, frozen.publication_id, frozen.retained_media_manifests);
        await setPagesBuildMediaAccess(cloudflare, projectRoot, environment, access);
      }
      await store.updateDoc(jobPath, { phase: 'publishing to GitHub' });
      await assertLease();
      const pushed = await publishTree(github, { owner: publication.owner, repo: publication.repo, branch: publication.branch, files, message: `Publish ${args.versionId} ${publication.publication_id.slice(0, 12)}` });
      publication = { ...publication, commit: pushed.commit };
      // Record the Git commit before Pages setup: recovery must never capture newer CMS edits.
      await store.updateDoc(jobPath, { git_publication: publication, phase: 'connecting Cloudflare build' });
    }
    let project = await cloudflare(projectRoot, { missing: true });
    if (!project) {
      const repository = await github(`/repos/${publication.owner}/${publication.repo}`);
      try { await cloudflare(`/accounts/${publication.account_id}/pages/projects`, { method: 'POST', body: pagesProjectBody({ owner: publication.owner, repo: publication.repo, repository, project: publication.project }) }); }
        catch { throw new ConnectionError('Cloudflare could not connect the generated repository. In Cloudflare → Workers & Pages → Create application → Pages → Connect to Git → + Add account, authorize Cloudflare’s GitHub App for the same organization with All repositories. Then retry the deployment. Also check your Pages project limit.', 409, 'cloudflare_git_setup_required'); }
      project = await cloudflare(projectRoot);
    }
    if (project.source?.type !== 'github' || project.source.config?.owner !== publication.owner || project.source.config?.repo_name !== publication.repo ||
        project.production_branch !== 'main' || project.build_config?.build_command !== 'npm ci && npm run build') {
      throw new ConnectionError('Cloudflare must use the generated GitHub repository and static build configuration.', 409);
    }
    if (!publication.commit) throw new Error('Frozen publication has no Git commit');
    let deployment = await findPublicationDeployment(cloudflare, projectRoot, { project: publication.project, commit: publication.commit, branch: publication.branch });
    if (!deployment || deployment.latest_stage?.name !== 'deploy' || deployment.latest_stage?.status !== 'success') {
      if (deployment?.is_skipped || ['failure', 'canceled'].includes(deployment?.latest_stage?.status)) throw new ConnectionError('The Cloudflare build failed. Open the generated project in Cloudflare → Workers & Pages → Deployments for the build log.', 502, 'customer_build_failed');
      await store.updateDoc(jobPath, { status: 'running', phase: 'building on Cloudflare' });
      return 'deferred';
    }
    if (deployment.uses_functions == null) deployment = await cloudflare(`${projectRoot}/deployments/${encodeURIComponent(deployment.id)}`);
    if (!matchingDeployment([deployment], { project: publication.project, commit: publication.commit, branch: publication.branch })) throw new ConnectionError('Cloudflare returned a different deployment. Retry verification of the generated Git commit.', 409, 'deployment_identity_mismatch');
    try { assertSuccessfulStaticDeployment(deployment, project); }
    catch { throw new ConnectionError('Cloudflare has not confirmed that this exact deployment uses static files only. Open the Cloudflare build status before retrying.', 409, 'static_build_verification_required'); }
    await releaseBuildAccess();
    const candidate = new URL(deployment.url);
    if (candidate.protocol !== 'https:' || !candidate.hostname.endsWith(`.${publication.project}.pages.dev`) || candidate.username || candidate.password || candidate.port) throw new Error('Unexpected Cloudflare deployment origin');
    if (!await probePublication(candidate.origin, '/.well-known/typeroll/publication.json', publication.publication_id)) return 'deferred';
    await recordPublishingOrigin(args.orgId, args.siteId, candidate.origin, true);
    const frozen = await readSnapshot(args, publication);
    if (frozen.media_manifest?.entries?.length && !await preparePublicMediaDomains(args.orgId, frozen.media_manifest)) {
      await store.updateDoc(jobPath, { phase: 'distributing media' });
      return 'deferred';
    }
    publication = { ...publication, deployment_id: deployment.id };
    await assertLease();
    await store.updateDoc(jobPath, { git_publication: publication, phase: 'ready to connect domain' });
    const preparation = await preparePagesDomain(cloudflare, { accountId: publication.account_id, project: publication.project,
      branch: publication.release_branch ?? publication.branch, hostname: publication.website_host,
      configureTraffic: !publication.release_branch,
      dnsMode: args.versionId === 'main' && domains.desired.website_host ? domains.dns_mode : organization.dns_mode });
    if (args.versionId === 'main') await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === publication!.domain_revision,
      { state: preparation.action === 'complete_validation' ? 'preparing' : 'ready_to_switch', preparation,
        candidate: { id: publication.publication_id, revision: publication.domain_revision, commit: publication.commit,
        deployment_id: deployment.id, verified_at: new Date().toISOString(), job_id: args.jobId } });
    if (publication.release_branch) {
      if (domains.cutover_approved_revision !== domains.revision) {
        await store.updateDoc(jobPath, { phase: 'awaiting domain cutover approval', dns_requirements: preparation.requirements });
        return 'deferred';
      }
      const { commit: _commit, deployment_id: _deployment, release_branch: _release, ...candidatePublication } = publication;
      publication = { ...candidatePublication, branch: 'main' };
      await store.updateDoc(jobPath, { git_publication: publication, phase: 'promoting verified source' });
      return 'deferred';
    }
    if (domains.cutover_approved_revision === domains.revision && domains.approved_preparation && domains.dns_mode === 'automatic') {
      await applyPreparedTraffic(cloudflare, domains.approved_preparation);
    }
    // A reachable pages.dev build is evidence, not the customer's public URL.
    if (!await probePublication(`https://${publication.website_host}`, '/.well-known/typeroll/publication.json', publication.publication_id)) {
      await store.updateDoc(jobPath, { phase: preparation.action === 'verify' ? 'distributing' : 'awaiting domain setup', dns_requirements: preparation.requirements });
      return 'deferred';
    }
    await recordPublishingOrigin(args.orgId, args.siteId, `https://${publication.website_host}`);
    const finished = new Date().toISOString();
    const stillOwned = await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease && target.lease_until > Date.now(), { lease_until: Date.now() + 60_000 });
    if (!stillOwned) return 'deferred';
    await store.updateDoc(jobPath, { status: 'succeeded', phase: 'live', deploy_url: `https://${publication.website_host}`, finished_at: finished });
    await store.updateDoc(paths.version(args.orgId, args.siteId, args.versionId), { last_deployed_at: finished, last_deployed_content_at: publication.content_cutoff, deploy_url: `https://${publication.website_host}` });
    if (args.versionId === 'main') {
      await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(args.orgId, args.siteId), current => current.revision === publication!.domain_revision,
        { active: { ...domains.desired, website_host: publication.website_host }, state: 'live',
          media_aliases: [...domains.media_aliases, ...(domains.active && !domains.media_aliases.some(alias => JSON.stringify(alias) === JSON.stringify(domains.active)) ? [domains.active] : [])] });
      await store.updateDoc(paths.site(args.orgId, args.siteId), { domain: publication.website_host, domain_status: 'live', domain_verified_at: finished });
    }
    for (const entry of frozen.media_manifest?.entries ?? []) {
      const mediaPath = `${paths.media(args.orgId, args.siteId)}/${entry.id}`;
      const aliases = [entry.cdn_url, ...entry.aliases.map((alias: any) => alias.url)];
      for (const width of [320, 640, 1024, 1920]) for (const format of ['webp', 'avif']) aliases.push(`${entry.cdn_url}.v1.w${width}.${entry.sha256.slice(0, 16)}.${format}`);
      const record = await store.getDoc<any>(mediaPath);
      if (record) await store.compareAndUpdateDoc<any>(mediaPath, current => current.sha256 === entry.sha256 && JSON.stringify(current.source_aliases) === JSON.stringify(record.source_aliases),
        { source_aliases: [...new Set([...(record.source_aliases ?? []), ...aliases])] });
    }
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease, { last_publication: publication });
    terminal = true;
    return 'ran';
  } catch (error) {
    const target = await store.getDoc<Target>(targetPath);
    if (target?.lease_id !== lease) return 'deferred';
    const failedJob = await store.getDoc<GitJob>(jobPath);
    const failure = { stage: failedJob?.phase ?? 'connecting publishing accounts',
      code: error instanceof ConnectionError ? error.code : error instanceof ProviderError ? 'provider_request_failed' : 'publication_internal_error',
      ...(error instanceof ProviderError ? { provider: error.provider, http_status: error.status, provider_codes: error.codes } : {}) };
    console.error(JSON.stringify({ event: 'customer_publication_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId, ...failure }));
    const message = error instanceof ConnectionError ? error.message : error instanceof ProviderError
      ? `${error.provider} returned HTTP ${error.status}${error.codes.length ? ` (code ${error.codes.join(', ')})` : ''} during ${failure.stage}. Open Publishing to check the connection and retry.`
      : `Publishing stopped during ${failure.stage}. Retry the deployment. If it fails again, contact support with deployment ${args.jobId}.`;
    await store.updateDoc(jobPath, { status: 'failed', phase: 'failed', finished_at: new Date().toISOString(),
      error: message, failure });
    terminal = true;
    return 'ran';
  } finally {
    try { await recordCustomerCompute(args.orgId, args.siteId, args.jobId, performance.now() - attemptStarted); }
    catch { console.error(JSON.stringify({ event: 'customer_publication_cost_failed', org_id: args.orgId, site_id: args.siteId, job_id: args.jobId })); }
    if (terminal) await releaseBuildAccess();
    await store.compareAndUpdateDoc<Target>(targetPath, target => target.lease_id === lease,
      { lease_id: null, lease_until: 0, ...(terminal ? { job_id: null } : {}) });
  }
}
