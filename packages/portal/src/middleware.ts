// load-env runs at module init, so .env values are in process.env before
// any route handler tries to read them. Mounted here because middleware is
// loaded once at SSR boot — earlier than any per-route module import.
import './lib/load-env';
import { defineMiddleware } from 'astro:middleware';
import { MAIN_VERSION_ID } from '@typeroll/shared';
import { enforceCsrf } from './lib/csrf';
import { getSession, sessionNeedsRefresh, refreshSessionForUser } from './lib/auth';

/**
 * The active site version (main vs a branch) travels in a cookie. Middleware
 * pulls it out and parks it on Astro.locals so pages and API routes don't
 * have to do their own cookie parsing.
 *
 * The cookie is *advisory* — every guard that actually loads versioned data
 * still validates the version against the current site, because a cookie set
 * for one site (e.g. "spring-redesign") would otherwise leak to a sibling
 * site that doesn't have that branch. See lib/access.ts:resolveVersionId.
 */

// Paths that a pending (org-less) session can still access. Everything else
// under /app or / gets bounced to /onboarding.
// SERVICE_ROLE=forms: this instance is the public forms service
// (forms.typeroll.com) — same image as the portal, locked to the forms
// surface. Everything else 404s so the portal admin/API never rides on
// the public hostname.
const FORMS_ROLE_ALLOWED = ['/api/forms/', '/api/analytics/', '/api/health'];

const ONBOARDING_EXEMPT_PREFIXES = [
  '/onboarding',
  '/login',
  '/api/',
  '/_astro/',
  '/favicon',
];

// Scheduled-publishing sweep, local-dev flavor. Production uses Cloud
// Scheduler → /api/internal/publish-sweep (OIDC-verified); in dev there is
// no scheduler, so the first request lazily starts a once-a-minute
// in-process interval. Keyed off DEPLOY_QUEUE like the deploy path: any
// value other than in-process means a real scheduler owns the cadence.
// Sweep errors are logged and swallowed — a broken sweep must never take
// the portal down.
let sweepTimerStarted = false;
function ensureDevPublishSweep(): void {
  if (sweepTimerStarted) return;
  sweepTimerStarted = true;
  const queueMode = process.env.DEPLOY_QUEUE ?? 'in_process';
  if (queueMode !== 'in_process') return;
  setInterval(() => {
    import('./lib/scheduled-publish')
      .then(({ runPublishSweep }) => runPublishSweep())
      .then((r) => {
        const n = r.pages_published + r.pages_unpublished + r.items_published + r.items_unpublished;
        if (n > 0) console.log(`[publish-sweep] fired: ${JSON.stringify(r)}`);
      })
      .catch((e) => console.error('[publish-sweep] failed:', e));
  }, 60_000).unref?.();
}

export const onRequest = defineMiddleware(async (context, next) => {
  ensureDevPublishSweep();
  if (process.env.SERVICE_ROLE === 'forms') {
    const path = new URL(context.request.url).pathname;
    if (!FORMS_ROLE_ALLOWED.some((p) => path.startsWith(p))) {
      return new Response('Not found', { status: 404 });
    }
  }

  const csrfReject = enforceCsrf({ request: context.request, url: context.url });
  if (csrfReject) return csrfReject;

  const cookie = context.cookies.get('typeroll_version')?.value;
  context.locals.versionId = cookie?.trim() || MAIN_VERSION_ID;

  // Redirect authenticated users without an org to /onboarding.
  // Only applies to app routes and the root path — API routes, login,
  // onboarding itself, and static assets are exempt.
  const pathname = context.url.pathname;
  const isAppOrRoot = pathname === '/' || pathname.startsWith('/app');
  if (isAppOrRoot && !ONBOARDING_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
    const session = await getSession(context.cookies);
    if (session && !session.orgId) {
      return context.redirect('/onboarding');
    }

    // Rolling session refresh: Firebase caps one session cookie at 14 days,
    // so "signed in until I log out" is implemented by re-minting the cookie
    // on activity — at most ~daily (sessionNeedsRefresh), page GETs only,
    // and strictly best-effort: a refresh failure must never break the page
    // view, the current cookie is still valid.
    if (session?.orgId && context.request.method === 'GET' && sessionNeedsRefresh(session)) {
      const apiKey = import.meta.env.PUBLIC_FIREBASE_API_KEY as string | undefined;
      if (apiKey) {
        try {
          await refreshSessionForUser(context.cookies, session.userId, apiKey);
        } catch {
          /* best-effort — keep serving with the existing cookie */
        }
      }
    }
  }

  return next();
});
