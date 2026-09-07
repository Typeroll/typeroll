import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { DeploymentAvailability, DeployJob, SiteVersion } from '@typeroll/shared';
import { getStore } from '../datastore';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { liveDeploymentUpdate } from './live-state';

export const PUBLICATION_HEADER = 'x-typeroll-publication';

/** The marker is part of each static response, never a dynamic serving layer. */
export async function stampPublication(buildDir: string): Promise<{ id: string; paths: string[] }> {
  const id = randomUUID();
  const routes: string[] = [];
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile() && entry.name.endsWith('.html') && relative !== '404.html') {
        routes.push(`/${relative.replace(/index\.html$/, '').replace(/\.html$/, '')}`);
      }
    }
  }
  await walk(buildDir);
  if (!routes.length) {
    // Publishing an empty site (including deleting its last page) must work.
    const marker = '.well-known/typeroll/publication.txt';
    await fs.mkdir(path.dirname(path.join(buildDir, marker)), { recursive: true });
    await fs.writeFile(path.join(buildDir, marker), id);
    routes.push(`/${marker}`);
  }
  await fs.appendFile(path.join(buildDir, '_headers'), `\n/*\n  X-Typeroll-Publication: ${id}\n`);
  return { id, paths: routes.sort() };
}

/** Reject stale HTTP 200 responses, redirects to other hosts, and private destinations. */
export async function probePublication(
  origin: string, route: string, id: string,
  opts: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination } = {},
): Promise<boolean> {
  try {
    const base = parsePublicHttpsUrl(origin);
    let url = parsePublicHttpsUrl(new URL(route, base).href);
    if (url.origin !== base.origin) return false;
    for (let redirects = 0; redirects < 4; redirects++) {
      await (opts.validate ?? assertPublicDestination)(url);
      const response = await (opts.fetchImpl ?? fetch)(url, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Typeroll-Publication-Check/1.0' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return false;
        url = parsePublicHttpsUrl(new URL(location, url).href);
        if (url.origin !== base.origin) return false;
        continue;
      }
      return response.status === 200 && response.headers.get(PUBLICATION_HEADER) === id;
    }
  } catch { /* DNS, TLS and edge propagation are pending, not a successful publication. */ }
  return false;
}

/** Observe a small batch per poll; builds never wait in a billable worker for CDN propagation. */
export async function refreshDeploymentAvailability(
  orgId: string, siteId: string, job: DeployJob,
  opts: { probe?: typeof probePublication; now?: () => string } = {},
): Promise<DeployJob> {
  if (job.status !== 'running' || job.phase !== 'distributing' || !job.availability) return job;
  const store = getStore();
  const availability = job.availability;
  const jobPath = paths.deploy(orgId, siteId, job.id);
  const completedAt = (opts.now ?? (() => new Date().toISOString()))();
  const affectsLiveVersion = job.version_id !== 'main' || job.environment === 'production';
  const version = affectsLiveVersion ? await store.getDoc<SiteVersion>(paths.version(orgId, siteId, job.version_id)) : null;
  const superseded = affectsLiveVersion && version?.distributing_deploy_id !== availability.id
    && version?.last_deployed_content_at !== availability.content_cutoff;
  if (superseded) {
    await store.compareAndUpdateDoc<DeployJob>(jobPath,
      current => current.status === 'running' && current.availability?.id === availability.id,
      { status: 'failed', phase: 'superseded', finished_at: completedAt, error: 'A newer publication replaced this deployment.' });
    return (await store.getDoc<DeployJob>(jobPath)) ?? job;
  }
  const targets = availability.origins.flatMap(origin => availability.paths.map(route => ({ origin, route })));
  if (!targets.length || availability.checked < 0 || availability.checked > targets.length) return job;
  const batch = targets.slice(availability.checked, availability.checked + 8);
  const checks = await Promise.all(batch.map(target => (opts.probe ?? probePublication)(target.origin, target.route, availability.id)));
  if (!checks.every(Boolean)) {
    const uploadedAt = Date.parse(availability.uploaded_at ?? '');
    if (Number.isFinite(uploadedAt) && Date.parse(completedAt) - uploadedAt > 5 * 60_000) {
      await store.compareAndUpdateDoc<DeployJob>(jobPath,
        current => current.status === 'running' && current.availability?.id === availability.id,
        { status: 'failed', phase: 'availability_timeout', finished_at: completedAt,
          error: 'The upload finished, but the public site is not ready after five minutes. Check the domain in Cloudflare, then retry the deployment.' });
      return (await store.getDoc<DeployJob>(jobPath)) ?? job;
    }
    return job;
  }
  const checked = availability.checked + batch.length;
  if (checked < targets.length) {
    await store.compareAndUpdateDoc<DeployJob>(jobPath,
      current => current.status === 'running' && current.availability?.id === availability.id && current.availability.checked === availability.checked,
      { availability: { ...availability, checked } });
    return (await store.getDoc<DeployJob>(jobPath)) ?? job;
  }
  const update = liveDeploymentUpdate({ versionId: job.version_id, environment: job.environment,
    contentCutoff: availability.content_cutoff, completedAt, deployUrl: job.deploy_url });
  if (update) {
    const versionPath = paths.version(orgId, siteId, job.version_id);
    await store.compareAndUpdateDoc<SiteVersion>(versionPath,
      current => current.distributing_deploy_id === availability.id,
      { ...update, distributing_deploy_id: null });
    const version = await store.getDoc<SiteVersion>(versionPath);
    // A newer publication owns this version now. Never revive an obsolete upload.
    if (version?.distributing_deploy_id || version?.last_deployed_content_at !== availability.content_cutoff) return job;
  }
  await store.compareAndUpdateDoc<DeployJob>(jobPath,
    current => current.status === 'running' && current.availability?.id === availability.id,
    { status: 'succeeded', phase: 'done', finished_at: completedAt, availability: { ...availability, checked } });
  return (await store.getDoc<DeployJob>(jobPath)) ?? job;
}
