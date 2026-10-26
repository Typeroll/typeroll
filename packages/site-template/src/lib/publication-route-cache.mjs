import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, routeFingerprint, validCacheEntry, domainRouteFingerprint, canRebaseCache, replaceRenderOrigins } from './publication-render-cache.mjs';
import { dependenciesMatch, refreshDependencies } from './publication-dependencies.mjs';

let input;
export async function renderCacheInput() {
  const directory = process.env.TYPEROLL_RENDER_CACHE_WORK;
  if (!directory) return null;
  input ??= fs.readFile(path.join(directory, 'input.json'), 'utf8').then(JSON.parse);
  return input;
}
export async function writeRouteReceipt(receipt) {
  await fs.writeFile(path.join(process.env.TYPEROLL_RENDER_CACHE_WORK, digest(receipt.pathname) + '.json'), JSON.stringify(receipt));
}
export async function selectChangedRoutes(routes, resolvers, trailingSlash) {
  const input = await renderCacheInput();
  if (!input) return routes;
  const base = process.env.TYPEROLL_SITE_URL;
  await fs.writeFile(path.join(path.dirname(process.env.TYPEROLL_RENDER_CACHE_WORK), 'routes.json'), JSON.stringify(routes.map(route => {
    const pathname = new URL(encodeURI(route.params.slug ? `/${route.params.slug}${trailingSlash === 'never' ? '' : '/'}` : '/'), base).pathname;
    const page = route.props.page;
    const canonical = page.canonical_url || new URL(pathname, base).href;
    const parents = (route.props.breadcrumbs ?? []).filter(crumb => !crumb.current && crumb.href !== '/');
    return { pathname, page_id: page.id, canonical, nofollow: page.nofollow === true, breadcrumbs: pathname === '/' ? [] : [
      { item: new URL('/', base).href }, ...parents.map(crumb => ({ item: new URL(crumb.href, base).href })), { item: canonical },
    ] };
  })));
  const changed = [];
  const queries = new Map();
  for (const route of routes) {
    const rawPath = route.params.slug ? `/${route.params.slug}${trailingSlash === 'never' ? '' : '/'}` : '/';
    const pathname = new URL(encodeURI(rawPath), 'https://publication.invalid').pathname;
    const previous = input.cache?.routes?.[pathname];
    const fingerprint = routeFingerprint(input.plan, pathname, route.props);
    if (validCacheEntry(previous, fingerprint) && dependenciesMatch(previous.dependencies, resolvers, queries)) {
      await writeRouteReceipt({ ...previous, pathname, reused: true, reason: 'unchanged' });
    } else if (canRebaseCache(input.cache, input.plan) && previous?.domain_fingerprint === domainRouteFingerprint(input.plan, pathname, route.props) && validCacheEntry(previous, previous.fingerprint)) {
      try {
        const html = replaceRenderOrigins(previous.html, input.cache.origins, input.plan.origins);
        const dependencies = refreshDependencies(previous.dependencies, resolvers, input.cache.origins, input.plan.origins, replaceRenderOrigins);
        await writeRouteReceipt({ ...previous, pathname, html, sha256: digest(html), fingerprint,
          domain_fingerprint: domainRouteFingerprint(input.plan, pathname, route.props), dependencies, dependencyHash: digest(dependencies), reused: true, reason: 'origins_rebased' });
      } catch { changed.push(route); }
    } else changed.push(route);
  }
  return changed;
}
