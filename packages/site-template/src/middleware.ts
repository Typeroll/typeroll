import { defineMiddleware } from 'astro:middleware';
import { digest, routeFingerprint } from './lib/publication-render-cache.mjs';
import { captureDependencies } from './lib/publication-dependencies.mjs';
import { renderCacheInput, writeRouteReceipt } from './lib/publication-route-cache.mjs';

// getStaticPaths removes reusable routes before Astro's render queue. Routes
// reaching middleware are rendered normally and record fresh dependencies.
export const onRequest = defineMiddleware(async (context, next) => {
  if (!process.env.TYPEROLL_RENDER_CACHE_WORK || !context.props.page) return next();
  const { plan } = await renderCacheInput();
  const pathname = context.url.pathname;
  const { value, dependencies } = await captureDependencies(async () => {
    const response = await next();
    // Consume the stream inside the tracking scope: Astro components can read
    // dependencies lazily while the response body is being produced.
    return { response, html: response.status === 200 ? await response.clone().text() : null };
  });
  if (value.html !== null) await writeRouteReceipt({ pathname,
    fingerprint: routeFingerprint(plan, pathname, context.props),
    html: value.html, sha256: digest(value.html), dependencies, dependencyHash: digest(dependencies),
    reused: false, reason: 'rendered',
  });
  return value.response;
});
