import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, routeFingerprint, validCacheEntry } from './publication-render-cache.mjs';
import { dependenciesMatch } from './publication-dependencies.mjs';

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
    } else changed.push(route);
  }
  return changed;
}
