import { withAccessRequest, OrganizationAccessError } from './lib/organization-access';
// load-env runs at module init, so .env values are in process.env before
// any route handler tries to read them. Mounted here because middleware is
// loaded once at SSR boot — earlier than any per-route module import.
import './lib/load-env';
import { requireCurrentDataSchema } from './lib/data-schema';
import { defineMiddleware } from 'astro:middleware';
import { MAIN_VERSION_ID } from '@typeroll/shared';
import { enforceCsrf } from './lib/csrf';
import { getSessionIdentity } from './lib/auth';
import { serviceRole } from './lib/release';
import { schedulingMode } from './lib/scheduling/transport';
import { StorageDocumentError } from './lib/firestore-codec';

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
const FORMS_ROLE_ALLOWED = [
  '/api/forms/',
  '/api/analytics/',
  '/api/healthz',
  '/api/readyz',
  '/api/version',
];

const ONBOARDING_EXEMPT_PREFIXES = [
  '/onboarding',
  '/login',
  '/api/',
  '/_astro/',
  '/favicon',
];

// Scheduled-publishing sweep, local-dev flavor. Deployed Workers use store
// alarms and the Cron trigger; with the local scheduler the first request
// lazily starts a once-a-minute in-process interval.
// Sweep errors are logged and swallowed — a broken sweep must never take
// the portal down.
let sweepTimerStarted = false;
function ensureDevPublishSweep(): void {
  if (sweepTimerStarted) return;
  sweepTimerStarted = true;
  if (serviceRole() !== 'portal') return;
  // Deployed Workers sweep from their Cron trigger; only local development polls.
  if (schedulingMode() !== 'local') return;
  setInterval(() => {
    requireCurrentDataSchema().then(() => import('./lib/scheduled-publish'))
      .then(({ runPublishSweep }) => runPublishSweep())
      .then((r) => {
        const n = r.pages_published + r.pages_unpublished;
        if (n > 0) console.log(`[publish-sweep] fired: ${JSON.stringify(r)}`);
      })
      .catch((e) => console.error('[publish-sweep] failed:', e));
  }, 60_000).unref?.();
}

// Anti-framing for portal documents (clickjacking). Every HTML page the portal
// serves is denied to all framers, except the preview documents the portal
// frames itself (editor canvases, review panes, revision and link previews),
// which stay frameable by the portal's own origin. Forms and Extension
// endpoints answer customer sites and Extension hosts, so their framing is
// left to the route. A route that already states a framing policy keeps it.
const SELF_FRAMED_PATHS = [
  /^\/api\/sites\/[^/]+\/preview\//,
  /^\/api\/sites\/[^/]+\/pages\/[^/]+\/revisions\/[^/]+\/preview$/,
  /^\/preview\//,
];
const ROUTE_OWNED_FRAMING_PREFIXES = ['/api/forms/', '/api/extensions/'];

function applyFramingPolicy(pathname: string, response: Response): Response {
  if (ROUTE_OWNED_FRAMING_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return response;
  if (!/^\s*text\/html\b/i.test(response.headers.get('content-type') ?? '')) return response;
  const selfFramed = SELF_FRAMED_PATHS.some((pattern) => pattern.test(pathname));
  const missingFrameAncestors = !/(^|[;,]\s*)frame-ancestors\b/i.test(response.headers.get('content-security-policy') ?? '');
  const missingFrameOptions = !response.headers.has('x-frame-options');
  if (!missingFrameAncestors && !missingFrameOptions) return response;
  const apply = (headers: Headers) => {
    // A second policy is enforced alongside any existing one (e.g. a preview's sandbox).
    if (missingFrameAncestors) headers.append('Content-Security-Policy', selfFramed ? "frame-ancestors 'self'" : "frame-ancestors 'none'");
    if (missingFrameOptions) headers.set('X-Frame-Options', selfFramed ? 'SAMEORIGIN' : 'DENY');
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    // Immutable headers (Response.redirect, fetched responses): copy once.
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (!['/api/healthz', '/api/version'].includes(context.url.pathname)) {
    try { await requireCurrentDataSchema(); }
    catch {
      return new Response('Typeroll is being upgraded. Please try again shortly.', {
        status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }
  const role = serviceRole();
  ensureDevPublishSweep();
  if (role === 'forms') {
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
    // An account without a confirmed email may only see "Check your email".
    // Everything else rejects it centrally because getSession() returns null.
    const identity = await getSessionIdentity(context.cookies);
    if (identity && !identity.emailVerified) {
      return context.redirect(pathname === '/app' || pathname === '/' ? '/verify-email' : `/verify-email?next=${encodeURIComponent(context.url.pathname + context.url.search)}`);
    }
    const session = identity;
    if (session && !session.orgId) {
      return context.redirect(pathname === '/app' ? '/onboarding' : `/onboarding?next=${encodeURIComponent(context.url.pathname + context.url.search)}`);
    }

  }

  try { return applyFramingPolicy(pathname, await withAccessRequest(context.request, next)); }
  catch (error) {
    if (error instanceof OrganizationAccessError) return error.response();
    if (context.url.pathname.startsWith('/api/') && error instanceof StorageDocumentError) {
      return new Response(JSON.stringify({ error: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) }), {
        status: error.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    throw error;
  }
});
