import { createHash } from 'node:crypto';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { generatedCloudflareNames } from './cloudflare-account-claims';
import { digest } from './providers.mjs';

type GithubClient = (path: string, options?: { missing?: boolean }) => Promise<any>;

/** Every generated repository carries this description; it proves which site a repository belongs to. */
export const generatedRepositoryDescription = (orgId: string, siteId: string) => `Generated Typeroll site ${digest(`${orgId}\0${siteId}`).slice(0, 16)}`;

/** `typeroll-<site id>` in GitHub's repository name characters, or null when the id has none. */
export function readableRepositoryName(siteId: string): string | null {
  const slug = siteId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 80).replace(/-+$/, '');
  return slug ? `typeroll-${slug}` : null;
}

/**
 * The GitHub repository that holds a site's generated source. It is chosen once,
 * at the site's first Git publication, and saved on the site. A site that already
 * has a repository keeps its generated hash name; a new site gets
 * `typeroll-<site id>`, with a short suffix when that name is taken in the owner
 * account. A lost saved choice is recovered from the repository description.
 * The publication runner still verifies ownership through the
 * repository description before it pushes.
 */
export async function siteRepositoryName(orgId: string, siteId: string, site: Site | null, github: GithubClient, owner: string): Promise<string> {
  if (site?.git_repository) return site.git_repository;
  const legacy = generatedCloudflareNames(orgId, siteId).pages_project!;
  // A name is usable when it is free, or already holds this site's source (a saved choice that was lost).
  const usable = async (name: string) => {
    const repository = await github(`/repos/${encodeURIComponent(owner)}/${name}`, { missing: true });
    return !repository || repository.description === generatedRepositoryDescription(orgId, siteId);
  };
  let chosen = legacy;
  // Every site published before this naming has a repository under its hash name.
  if (!await github(`/repos/${encodeURIComponent(owner)}/${legacy}`, { missing: true })) {
    const readable = readableRepositoryName(siteId);
    const suffixed = readable && `${readable}-${createHash('sha256').update(`${orgId}\0${siteId}`).digest('hex').slice(0, 4)}`;
    if (readable && await usable(readable)) chosen = readable;
    else if (suffixed && await usable(suffixed)) chosen = suffixed;
  }
  const store = getStore(), path = paths.site(orgId, siteId);
  await store.compareAndUpdateDoc<Site>(path, current => !current.git_repository, { git_repository: chosen });
  return (await store.getDoc<Site>(path))?.git_repository ?? chosen;
}
