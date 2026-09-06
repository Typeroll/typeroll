import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digest, pagesProjectBody, assertPagesProject, publishTree, matchingDeployment,
  assertSuccessfulStaticDeployment,
} from './customer-publishing.mjs';

const fixtureRoot = fileURLToPath(new URL('../fixtures/customer-publishing/', import.meta.url));
const fixtureFiles = ['package.json', 'package-lock.json', 'astro.config.mjs', 'scripts/build.mjs', 'scripts/verify-publication.mjs', 'src/pages/[...slug].astro', 'public/_headers'];

export function buildPublishingProbePlan(config) {
  const allowed = ['github_owner', 'cloudflare_account_id', 'github_app_id', 'github_installation_id', 'prefix', 'media_bucket'];
  if (!config || typeof config !== 'object' || Object.keys(config).some((key) => !allowed.includes(key))) throw new Error('Unexpected probe configuration field');
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(config.github_owner ?? '') ||
      !/^[a-f0-9]{32}$/.test(config.cloudflare_account_id ?? '') ||
      !/^\d+$/.test(String(config.github_app_id)) || !/^\d+$/.test(String(config.github_installation_id)) ||
      !/^tr-probe-[a-z0-9][a-z0-9-]{0,25}$/.test(config.prefix ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.media_bucket ?? '')) throw new Error('Invalid probe configuration');
  const normalized = Object.fromEntries(allowed.map((key) => [key, String(config[key])]));
  const implementationFiles = [
    fileURLToPath(import.meta.url), fileURLToPath(new URL('./customer-publishing.mjs', import.meta.url)),
    fileURLToPath(new URL('../customer-publishing-probe.mjs', import.meta.url)),
    ...fixtureFiles.map((file) => path.join(fixtureRoot, file)),
  ];
  const implementation = digest(JSON.stringify(implementationFiles.map((file) => digest(readFileSync(file)))));
  const fingerprint = digest(JSON.stringify({ config: normalized, implementation }));
  return {
    format_version: 1,
    fingerprint,
    implementation_sha256: implementation,
    config: normalized,
    repositories: [1, 2, 3].map((number) => `${config.prefix}-${String(number).padStart(2, '0')}`),
    media_key: `${config.prefix}/${fingerprint}/upload-probe.txt`,
    branches: ['main', 'version-next'],
    effects: [
      'Create or resume three dedicated private repositories and Git-integrated Pages projects',
      'Commit synthetic Astro source and run three production publications and one preview; initial project and branch builds may consume up to eight builds in total',
      'Write one small synthetic object to the existing R2 bucket through a presigned URL',
      'Leave all test resources in place; do not attach domains or touch customer content',
    ],
  };
}

export async function probePublicationFiles(plan, repo, revision = 'published') {
  if (!plan.repositories.includes(repo) || !['published', 'next'].includes(revision)) throw new Error('Unknown probe publication');
  const files = Object.fromEntries(await Promise.all(fixtureFiles.map(async (file) => [file, await fs.readFile(path.join(fixtureRoot, file), 'utf8')])));
  const pages = Array.from({ length: 50 }, (_, index) => ({
    slug: index === 0 ? '' : `page-${index + 1}`,
    title: `Synthetic ${revision} page ${index + 1}`,
    text: 'Generated publication test content. No customer data.',
  }));
  const content = { site: repo, revision, pages };
  files['publication.json'] = `${JSON.stringify(content, null, 2)}\n`;
  files['publication-manifest.json'] = `${JSON.stringify({ format_version: 1, plan: plan.fingerprint, content_sha256: digest(files['publication.json']) }, null, 2)}\n`;
  files['README.md'] = '# Generated static publication probe\n\nAll source is generated. Manual changes are replaced by the next publication.\n\nRun `npm ci` and `npm run build` with Node 22.23.1. Output is `dist/`.\nThis fixture proves provider onboarding, not full Typeroll renderer parity.\n';
  return files;
}

export async function prepareProbeDirectory(plan, destination) {
  await fs.mkdir(destination, { recursive: false });
  for (const repo of plan.repositories) {
    const files = await probePublicationFiles(plan, repo);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(destination, repo, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: 'wx' });
    }
  }
  return { destination, sites: plan.repositories.length, pages_per_site: 50 };
}

function assertRepository(repository, plan, name) {
  if (repository.name !== name || repository.owner?.login?.toLowerCase() !== plan.config.github_owner.toLowerCase() ||
      repository.private !== true || repository.archived || repository.disabled ||
      repository.description !== `Typeroll publication probe ${plan.fingerprint}` || !repository.id || !repository.owner?.id) {
    throw new Error('Repository does not belong to this isolated publication probe');
  }
}

export async function ensureProbeResources(plan, name, { github, cloudflare }) {
  const owner = plan.config.github_owner;
  const repoPath = `/repos/${owner}/${name}`;
  let repository = await github(repoPath, { missing: true });
  if (!repository) {
    repository = await github(`/orgs/${owner}/repos`, { method: 'POST', body: {
      name, private: true, description: `Typeroll publication probe ${plan.fingerprint}`,
      auto_init: true, has_issues: false, has_projects: false, has_wiki: false,
    } });
    // Re-read through the installation token. Creating a repo is not proof of
    // subsequent access through the installation's repository selection.
    repository = await github(repoPath);
  }
  assertRepository(repository, plan, name);
  if (repository.default_branch !== 'main') throw new Error('Probe organization must initialize repositories on main');
  const expected = pagesProjectBody({ owner, repo: name, repository, project: name });
  const projects = `/accounts/${plan.config.cloudflare_account_id}/pages/projects`;
  let project = await cloudflare(`${projects}/${name}`, { missing: true });
  if (!project) {
    // Initialize source before connecting Pages to avoid a failed bootstrap build.
    const bootstrapFiles = await probePublicationFiles(plan, name);
    bootstrapFiles['probe-bootstrap.txt'] = 'Removed by the first publication after Pages connects.\n';
    await publishTree(github, { owner, repo: name, files: bootstrapFiles, message: 'Prepare synthetic site build' });
    await cloudflare(projects, { method: 'POST', body: expected });
    project = await cloudflare(`${projects}/${name}`);
  }
  assertPagesProject(project, expected);
  return { repository, project };
}

export async function observeProbeDeployment(plan, name, publication, { cloudflare, fetchImpl = fetch }) {
  const root = `/accounts/${plan.config.cloudflare_account_id}/pages/projects/${name}`;
  const deployments = await cloudflare(`${root}/deployments?per_page=100`);
  const deployment = matchingDeployment(deployments, { project: name, commit: publication.commit, branch: publication.branch });
  if (!deployment) return { state: 'waiting', commit: publication.commit, branch: publication.branch };
  if (deployment.is_skipped || ['failure', 'canceled'].includes(deployment.latest_stage?.status)) {
    return { state: 'failed', commit: publication.commit, branch: publication.branch, deployment_id: deployment.id };
  }
  if (deployment.latest_stage?.name !== 'deploy' || deployment.latest_stage?.status !== 'success') {
    return { state: 'building', commit: publication.commit, branch: publication.branch, deployment_id: deployment.id };
  }
  assertSuccessfulStaticDeployment(deployment);
  let url;
  try { url = new URL(deployment.url); } catch { throw new Error('Invalid Pages deployment URL'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(`.${name}.pages.dev`) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Unexpected Pages deployment URL');
  }
  // Check the immutable deployment and, for main, the actual live project URL.
  const urls = [url.origin];
  if (publication.branch === 'main') {
    const project = await cloudflare(root);
    if (project.canonical_deployment?.id !== deployment.id) return { state: 'waiting', commit: publication.commit, branch: publication.branch };
    urls.push(`https://${name}.pages.dev`);
  }
  const revision = publication.branch === 'main' ? 'published' : 'next';
  for (const origin of urls) {
    for (const route of ['/', '/page-50/']) {
      let response;
      try { response = await fetchImpl(`${origin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch { throw new Error('Published probe is not reachable'); }
      const html = await response.text();
      if (!response.ok || !html.includes(`data-probe-site="${name}"`) || !html.includes(`data-probe-revision="${revision}"`)) {
        throw new Error('Published probe does not match the requested site and revision');
      }
    }
  }
  return { state: 'verified', commit: publication.commit, branch: publication.branch, deployment_id: deployment.id, url: url.origin };
}

/** One pass only: waiting for provider builds is a separate, resumable call. */
export async function runPublishingProbe(plan, { github, cloudflare, probeMedia, fetchImpl, log = () => {} }) {
  const account = await cloudflare(`/accounts/${plan.config.cloudflare_account_id}`);
  if (account.id !== plan.config.cloudflare_account_id) throw new Error('Cloudflare account does not match the plan');
  const media = await probeMedia(plan);
  const results = [];
  for (const name of plan.repositories) {
    log({ phase: 'provisioning', resource: name });
    await ensureProbeResources(plan, name, { github, cloudflare });
    const publication = await publishTree(github, {
      owner: plan.config.github_owner, repo: name, files: await probePublicationFiles(plan, name), message: 'Publish synthetic site',
    });
    const result = await observeProbeDeployment(plan, name, publication, { cloudflare, fetchImpl });
    results.push({ site: name, ...result });
  }
  if (results.every((result) => result.state === 'verified')) {
    const name = plan.repositories[0];
    const preview = await publishTree(github, {
      owner: plan.config.github_owner, repo: name, branch: 'version-next',
      files: await probePublicationFiles(plan, name, 'next'), message: 'Publish synthetic version preview',
    });
    results.push({ site: name, ...await observeProbeDeployment(plan, name, preview, { cloudflare, fetchImpl }) });
    // Publishing a version branch must not move the live deployment.
    const main = results[0];
    const verified = await observeProbeDeployment(plan, name, main, { cloudflare, fetchImpl });
    if (verified.state !== 'verified') throw new Error('Version preview changed the published site');
  }
  return {
    plan: plan.fingerprint, media,
    state: results.length === 4 && results.every((result) => result.state === 'verified') ? 'verified' : results.some((result) => result.state === 'failed') ? 'failed' : 'pending',
    sites: results,
  };
}

export async function probeR2Upload(plan, credentials, fetchImpl = fetch) {
  const { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('R2 probe credentials are required');
  const client = new S3Client({ region: 'auto', endpoint: `https://${plan.config.cloudflare_account_id}.r2.cloudflarestorage.com`, credentials });
  const params = { Bucket: plan.config.media_bucket, Key: plan.media_key };
  const content = `Typeroll synthetic upload probe ${plan.fingerprint}\n`;
  try {
    await client.send(new HeadBucketCommand({ Bucket: params.Bucket }), { abortSignal: AbortSignal.timeout(30_000) });
    const signed = await getSignedUrl(client, new PutObjectCommand({ ...params, ContentType: 'text/plain' }), { expiresIn: 60 });
    const response = await fetchImpl(signed, { method: 'PUT', redirect: 'error', body: content, headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Upload failed');
    const object = await client.send(new GetObjectCommand(params), { abortSignal: AbortSignal.timeout(30_000) });
    if (await object.Body?.transformToString() !== content) throw new Error('Readback mismatch');
    return { state: 'verified', bucket: params.Bucket, key: params.Key, bytes: Buffer.byteLength(content) };
  } catch {
    throw new Error('R2 direct upload/readback failed; check bucket-scoped credentials and permissions');
  } finally { client.destroy(); }
}
