import { defineMiddleware } from 'astro:middleware';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, routeFingerprint, validCacheEntry } from './lib/publication-render-cache.mjs';

// Frozen publications opt in through their build script. Portal previews and
// ordinary starter builds never read or write a publication cache.
let state: Promise<any> | undefined;
export const onRequest = defineMiddleware(async (context, next) => {
  const directory = process.env.TYPEROLL_RENDER_CACHE_WORK;
  if (!directory || !context.props.page) return next();
  state ??= fs.readFile(path.join(directory, 'input.json'), 'utf8').then(JSON.parse);
  const { plan, cache } = await state;
  const pathname = context.url.pathname;
  const fingerprint = routeFingerprint(plan, pathname, context.props);
  const previous = cache?.routes?.[pathname];
  const reused = validCacheEntry(previous, fingerprint);
  const response = reused ? new Response(previous.html, { headers: { 'Content-Type': 'text/html' } }) : await next();
  if (response.status === 200) {
    const html = await response.clone().text();
    await fs.writeFile(path.join(directory, digest(pathname) + '.json'), JSON.stringify({
      pathname, fingerprint, html, sha256: digest(html), reused: Boolean(reused),
      reason: reused ? 'unchanged' : previous ? 'dependencies_changed' : 'no_cached_route',
    }));
  }
  return response;
});
