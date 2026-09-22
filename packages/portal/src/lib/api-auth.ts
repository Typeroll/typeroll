// Auth guard for the public REST API at /api/v1/*. Mirrors the shape of
// requireSiteAccess() in lib/access.ts but auths with a bearer token instead
// of a session cookie, and binds the request to the site declared in the
// URL (not just the org).
//
// What this guard does:
//   1. Reads the Authorization header.
//   2. Verifies the token via verifyApiToken (timing-safe hash compare).
//   3. Confirms the URL's siteId matches the token's owning siteId. A
//      legitimate token only ever talks to its own site — cross-site reach
//      is not in the v1 scope.
//   4. Loads the Site doc so callers can use site.id + site.name.
//   5. Resolves the optional ?version=<id> query into a trusted versionId,
//      refusing with 404 when the id doesn't name a version of this site.
//   6. Fires a non-blocking recordKeyUse so the UI shows last-used info.
//
// Any failure returns a 401/403 Response. Routes call this and short-circuit
// the same way they do for requireSiteAccess.

import { paths, MAIN_VERSION_ID, ARCHIVED_SITE_MESSAGE, isArchivedSite } from '@typeroll/shared';
import type { ExtensionScope, Site, SharePermission } from '@typeroll/shared';
import { getStore } from './datastore';
import { json, resolveRequestedVersion, unknownVersionResponse } from './access';
import { recordKeyUse, verifyApiToken } from './api-keys';
import { rateLimit } from './rate-limit';
import { recordAudit, previewBody, shouldAudit } from './api-audit';
import { hydrateSharedSites } from './shares';

export interface ApiContext {
  /** Org that owns the resolved site (owner-side). For owned sites this is
   *  the token's org; for shared-in sites accessed via an org-scoped key
   *  it's the original owner. Always the org to use for datastore paths. */
  orgId: string;
  /** Original org of the presenting token. Useful for audit ("which org's
   *  key touched this site") — differs from orgId when the token reaches
   *  a shared-in site. */
  tokenOrgId: string;
  /** Site binding of the presented key: a site id for site-scoped keys,
   *  `null` for org-scoped keys. Routes without a {siteId} URL segment
   *  (the /v1/sites listing) branch on this instead of sniffing the
   *  placeholder site fields. */
  tokenSiteId: string | null;
  siteId: string;
  site: Site & { id: string };
  versionId: string;
  keyPrefix: string;
  /** Permission level the token has on this site. `'admin'` for owned
   *  sites and for any site under a site-scoped key; for shared-in sites
   *  it's the share's permission. Mutating routes can gate on this. */
  permission: SharePermission;
  /** Original request — kept on the context so route handlers can build
   *  audit entries and rate-limit-aware responses without re-threading
   *  arguments around. */
  request: Request;
  /** Stable identifier of the resource this request targets, for audit
   *  log paths. Equal to the URL pathname; doesn't include the origin. */
  path: string;
  /** Present when the caller used a scoped Extension installation credential. */
  extensionIdentity?: { installationId: string; scopes: ExtensionScope[] };
}

/**
 * Resolve which org owns `urlSiteId` for the given token, honoring both
 * direct ownership and cross-org sharing. Returns null if the token cannot
 * reach this site at all (site-scoped key mismatch, no share, etc.).
 *
 * For site-scoped tokens, only the bound site is reachable.
 * For org-scoped tokens, owned + shared-in sites are reachable.
 */
async function resolveTokenSite(
  tokenOrgId: string,
  tokenSiteId: string | null,
  urlSiteId: string,
): Promise<{
  ownerOrgId: string;
  permission: SharePermission;
  site: Site & { id: string };
} | null> {
  const store = getStore();
  if (tokenSiteId !== null) {
    // Site-scoped key — only the bound site is reachable, full admin.
    if (tokenSiteId !== urlSiteId) return null;
    const site = await store.getDoc<Site>(paths.site(tokenOrgId, urlSiteId));
    if (!site) return null;
    return { ownerOrgId: tokenOrgId, permission: 'admin', site };
  }
  // Org-scoped key — check owned-by-tokenOrgId first.
  const owned = await store.getDoc<Site>(paths.site(tokenOrgId, urlSiteId));
  if (owned) return { ownerOrgId: tokenOrgId, permission: 'admin', site: owned };
  // Fall back to shared-in via the cross-org share index.
  const shared = await hydrateSharedSites(tokenOrgId);
  const match = shared.find((s) => s.site.id === urlSiteId);
  if (!match) return null;
  return {
    ownerOrgId: match.share.owner_org_id,
    permission: match.share.permission,
    site: match.site,
  };
}

// Rate limits per key, sliding-window-style (lib/rate-limit uses fixed
// windows but at our scale the difference is invisible). Writes are 10x
// stricter than reads because they're the expensive thing — both for us
// and for the customer's site state.
const READ_LIMIT = 600;   // requests/min
const WRITE_LIMIT = 60;
const WINDOW_MS = 60_000;

export type GuardResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function getBearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim() || null;
}

/**
 * Which query parameter names the *site* version on this route.
 *
 * `?version=` means the block package's semver on the blocks export route —
 * `?name=trip&version=2` packs a package, it does not select a branch. There
 * the site version travels as `?version_branch=`, the name the MCP tool has
 * always shown its callers. Everywhere else `?version=` is the site version.
 *
 * One parameter with two meanings is the defect this guard exists to stop, so
 * the two are separated on the wire rather than guessed apart by shape.
 */
function siteVersionParam(pathname: string): 'version' | 'version_branch' {
  return /\/blocks\/export\/?$/.test(pathname) ? 'version_branch' : 'version';
}

export function extensionScopeForApiRequest(pathname: string, method: string): ExtensionScope | null {
  if (/\/delivery\/inbound(?:\/[a-f0-9]{64})?\/?$/.test(pathname) && method === 'GET') return 'email:inbound:status';
  const write = method !== 'GET' && method !== 'HEAD';
  if (/\/extensions\/self\/?$/.test(pathname) && !write) return 'extension:config:read';
  if (/\/pages\/[^/]+\/owner-fields\/?$/.test(pathname)) return 'content:owner';
  if (/\/delivery\/email\/?$/.test(pathname) && method === 'POST') return 'email:send';
  if (/\/delivery\/email\/[a-f0-9]{64}\/?$/.test(pathname) && method === 'GET') return 'email:send';
  if (!write && /\/apps\/documentation\/?$/.test(pathname)) return 'content:read';
  if (/\/deploys?(?:\/|$)/.test(pathname)) return 'deploy:request';
  if (/\/submissions(?:\/|$)/.test(pathname)) return write ? null : 'submissions:read';
  if (/\/forms\/[^/]+\/actions\/?$/.test(pathname) && method === 'POST') return 'forms:execute';
  if (/\/forms(?:\/|$)/.test(pathname)) return write ? 'forms:write' : 'forms:read';
  if (/\/media(?:\/|$)/.test(pathname)) return write ? 'media:write' : 'media:read';
  if (/\/(?:pages|content-types|partials|block-types|blocks|templates|settings)(?:\/|$)/.test(pathname)) {
    return write ? 'content:write' : 'content:read';
  }
  return null;
}

async function requireExtensionApiCredential(
  request: Request,
  urlSiteId: string,
  token: string,
): Promise<GuardResult<ApiContext>> {
  const ownerOrgId = request.headers.get('x-typeroll-organization-id') ?? '';
  const installationId = request.headers.get('x-typeroll-installation-id') ?? '';
  if (!ownerOrgId || !installationId || ownerOrgId.includes('/') || installationId.includes('/')) {
    return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  }
  const { authenticateInstallationCredential } = await import('./extensions/auth');
  let authenticated: Awaited<ReturnType<typeof authenticateInstallationCredential>>;
  try {
    authenticated = await authenticateInstallationCredential({
      ownerOrgId,
      siteId: urlSiteId,
      installationId,
      credential: token,
    });
  } catch {
    return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  }
  const pathname = new URL(request.url).pathname;
  const requiredScope = extensionScopeForApiRequest(pathname, request.method);
  if (!requiredScope || !authenticated.scopes.includes(requiredScope)) {
    return { ok: false, response: json({ error: 'Extension credential lacks the required scope' }, 403) };
  }
  const site = await getStore().getDoc<Site>(paths.site(ownerOrgId, urlSiteId));
  if (!site) return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  const resolvedVersion = await resolveRequestedVersion(
    ownerOrgId, urlSiteId,
    new URL(request.url).searchParams.get(siteVersionParam(pathname)),
  );
  if (!resolvedVersion.ok) {
    return { ok: false, response: unknownVersionResponse(resolvedVersion.requested) };
  }
  const versionId = resolvedVersion.versionId;
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
  // An archived site is inspectable but frozen, for an installation exactly
  // as for a person. Refused before the rate-limit bucket: a write that can
  // never succeed should not spend the installation's budget.
  if (isWrite && isArchivedSite(site)) {
    return { ok: false, response: json({ error: ARCHIVED_SITE_MESSAGE }, 409) };
  }
  const limit = rateLimit(`${isWrite ? 'ew' : 'er'}:${installationId}`, isWrite ? WRITE_LIMIT : READ_LIMIT, WINDOW_MS);
  if (!limit.allowed) return { ok: false, response: json({ error: 'Rate limit exceeded' }, 429) };
  return {
    ok: true,
    value: {
      orgId: ownerOrgId,
      tokenOrgId: ownerOrgId,
      tokenSiteId: urlSiteId,
      siteId: urlSiteId,
      site,
      versionId,
      keyPrefix: `extension:${installationId}`,
      permission: 'admin',
      request,
      path: pathname,
      extensionIdentity: { installationId, scopes: authenticated.scopes },
    },
  };
}

function clientIp(request: Request): string | undefined {
  // Cloud Run honours X-Forwarded-For; first hop is the real client.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || undefined;
  return undefined;
}

/**
 * Lighter variant for routes that don't have a {siteId} URL segment.
 * Verifies the token and returns the site it's bound to. Useful only for
 * the /v1/sites listing endpoint — every other route should use
 * requireApiKey which also enforces "URL site == token site".
 */
/**
 * An optional declaration of the organization the caller believes it is
 * addressing, checked against the one the key actually resolves to.
 *
 * A site id is unique within an organization and not across them. `moveria-se`
 * exists in two, and on 2026-09-21 a shared key resolved it to the wrong one,
 * succeeded, and produced an internally coherent measurement of a different
 * site that refuted a correct bug report. Nothing in the request or the
 * response said which organization had been reached.
 *
 * Carried in a header rather than the path, because the path is not changing:
 * not API routes, not media URLs. Absent, behaviour is exactly as before, so
 * no existing caller breaks. Present and wrong, the request fails instead of
 * quietly doing the right thing to the wrong site.
 *
 * 409 rather than 403: the caller is authorized and the request is well
 * formed. What conflicts is its belief about where it is pointed.
 */
export const ORGANIZATION_HEADER = 'Typeroll-Organization';

export function organizationMismatch(request: Request, resolvedOrgId: string): Response | null {
  const declared = request.headers.get(ORGANIZATION_HEADER)?.trim();
  if (!declared || declared === resolvedOrgId) return null;
  return json(
    {
      error: `This key resolves to organization "${resolvedOrgId}", not the declared "${declared}". `
        + 'A site id is unique within an organization and not across them, so the same id may name a different site here.',
      declared_organization: declared,
      resolved_organization: resolvedOrgId,
    },
    409,
  );
}

export async function requireAnyApiKey(request: Request): Promise<GuardResult<ApiContext>> {
  const token = getBearer(request);
  if (!token) {
    return {
      ok: false,
      response: json(
        { error: 'Missing bearer token. Send Authorization: Bearer typeroll_live_<...>' },
        401,
      ),
    };
  }
  if (token.startsWith('tri_')) {
    return { ok: false, response: json({ error: 'Extension credentials require a site-bound API route' }, 403) };
  }
  const verified = await verifyApiToken(token);
  if (!verified) {
    return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  }
  // Checked against the token's own organization here: with no site in the
  // URL, "which organization am I on" is a question about the key itself, and
  // it is the question a caller listing sites is usually asking.
  const declaredMismatch = organizationMismatch(request, verified.orgId);
  if (declaredMismatch) return { ok: false, response: declaredMismatch };

  // For org-scoped tokens we have no specific site yet — return a context
  // where site fields are placeholders; the listing route branches on
  // tokenSiteId and resolves its reach via listAllowedSites instead of
  // reading the placeholder. Site-scoped tokens still load the single site
  // they're bound to.
  const store = getStore();
  let site: Site & { id: string };
  let ownerOrgId = verified.orgId;
  let siteId: string;
  if (verified.siteId === null) {
    siteId = '';
    site = { id: '', name: '', hosting_adapter: 'cloudflare', created_at: '' } as Site & { id: string };
  } else {
    const loaded = await store.getDoc<Site>(paths.site(verified.orgId, verified.siteId));
    if (!loaded) return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
    site = loaded;
    siteId = verified.siteId;
    ownerOrgId = verified.orgId;
  }

  const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
  const limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  const rl = rateLimit(`${isWrite ? 'w' : 'r'}:${verified.prefix}`, limit, WINDOW_MS);
  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retry_after_seconds: retryAfter }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } },
      ),
    };
  }

  void recordKeyUse(verified.orgId, verified.siteId, verified.prefix, clientIp(request));
  return {
    ok: true,
    value: {
      orgId: ownerOrgId,
      tokenOrgId: verified.orgId,
      tokenSiteId: verified.siteId,
      siteId,
      site,
      versionId: MAIN_VERSION_ID,
      keyPrefix: verified.prefix,
      permission: 'admin',
      request,
      path: new URL(request.url).pathname,
    },
  };
}

export async function requireApiKey(
  request: Request,
  urlSiteId: string | undefined,
): Promise<GuardResult<ApiContext>> {
  if (!urlSiteId) {
    return { ok: false, response: json({ error: 'Missing siteId' }, 400) };
  }
  const token = getBearer(request);
  if (!token) {
    // 401 vs 403: missing credential is 401 ("authenticate"); valid but
    // wrong-site is 403 ("authenticated but forbidden").
    return {
      ok: false,
      response: json(
        { error: 'Missing bearer token. Send Authorization: Bearer typeroll_live_<...>' },
        401,
      ),
    };
  }
  if (token.startsWith('tri_')) return requireExtensionApiCredential(request, urlSiteId, token);
  const verified = await verifyApiToken(token);
  if (!verified) {
    return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  }
  const resolved = await resolveTokenSite(verified.orgId, verified.siteId, urlSiteId);
  if (!resolved) {
    // Don't leak whether the key is valid for some other site — opaque 401.
    return { ok: false, response: json({ error: 'Invalid or revoked token' }, 401) };
  }
  const { ownerOrgId, permission, site } = resolved;
  const declaredMismatch = organizationMismatch(request, ownerOrgId);
  if (declaredMismatch) return { ok: false, response: declaredMismatch };

  // ?version=<id> resolves through the one resolver in lib/access. An id that
  // doesn't name a version of this site is refused with 404 rather than
  // answered about main: 98 v1 routes come through here and 70 of them write,
  // so a lenient fallback turns a stale branch name into a silent write to
  // production main. The advisory cookie path keeps its fallback; an explicit
  // query parameter does not.
  const url = new URL(request.url);
  const resolvedVersion = await resolveRequestedVersion(
    ownerOrgId, urlSiteId, url.searchParams.get(siteVersionParam(url.pathname)),
  );
  if (!resolvedVersion.ok) {
    return { ok: false, response: unknownVersionResponse(resolvedVersion.requested) };
  }
  const versionId = resolvedVersion.versionId;

  // Block writes through a read-only share before any rate-limit work —
  // a write rejected at the share level shouldn't even consume the write
  // bucket. For site-scoped keys permission is always 'admin'.
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
  if (isWrite && permission === 'read') {
    return { ok: false, response: json({ error: 'This token has read-only access to this site' }, 403) };
  }
  // Same rule as the session API: archived means frozen, not hidden. Without
  // this an API key or an MCP agent would keep writing to a site the portal
  // no longer shows anyone.
  if (isWrite && isArchivedSite(site)) {
    return { ok: false, response: json({ error: ARCHIVED_SITE_MESSAGE }, 409) };
  }
  // Rate limit per key. Reads and writes share separate buckets so a
  // chatty read agent doesn't starve a deploy-trigger write.
  const bucketKey = `${isWrite ? 'w' : 'r'}:${verified.prefix}`;
  const limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  const rl = rateLimit(bucketKey, limit, WINDOW_MS);
  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          limit,
          window_seconds: WINDOW_MS / 1000,
          retry_after_seconds: retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(rl.resetAt / 1000)),
          },
        },
      ),
    };
  }

  // Telemetry fire-and-forget. Failures here must NOT affect the response.
  void recordKeyUse(verified.orgId, verified.siteId, verified.prefix, clientIp(request));

  return {
    ok: true,
    value: {
      orgId: ownerOrgId,
      tokenOrgId: verified.orgId,
      tokenSiteId: verified.siteId,
      siteId: urlSiteId,
      site,
      versionId,
      keyPrefix: verified.prefix,
      permission,
      request,
      path: new URL(request.url).pathname,
    },
  };
}

/**
 * Build a JSON response with the audit log fired off for writes. Use this
 * instead of `json()` in /api/v1 handlers so the audit happens at the same
 * point the response is sent.
 *
 * The `bodyForAudit` is the parsed request body that the route already
 * read; we don't re-read the request stream here. Pass `undefined` for
 * GETs (they're filtered out by shouldAudit anyway).
 */
/**
 * Which site, in which organization, this call actually reached.
 *
 * A site id is unique within an organization, not across them, and
 * resolveTokenSite deliberately prefers the token's own org — that is the
 * tenant boundary working. The hazard is not cross-tenant access, it's
 * ambiguity: an integrator holding a key for the wrong organization, using an
 * id that exists in both, edits the wrong site and gets a 200 with nothing in
 * the response to say so.
 *
 * The site header is omitted rather than sent empty for org-scoped listing
 * contexts, whose site fields are placeholders. A header that is sometimes a
 * lie is worse than one that is sometimes absent.
 */
export function apiIdentityHeaders(ctx: Pick<ApiContext, 'orgId' | 'siteId'>): Record<string, string> {
  return {
    'Typeroll-Organization-Id': ctx.orgId,
    ...(ctx.siteId ? { 'Typeroll-Site-Id': ctx.siteId } : {}),
  };
}

/**
 * Stamp identity onto a response this module did not build — a delegated
 * handler, or a raw body like the export archive.
 *
 * Exists because apiResponse is the seam for 101 of the 105 v1 routes and not
 * for the other four, and those four are where extension integrators work.
 * Rebuilds rather than mutates: a Response's headers are immutable once it has
 * been constructed by some code paths.
 */
export function withApiIdentity(ctx: Pick<ApiContext, 'orgId' | 'siteId'>, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(apiIdentityHeaders(ctx))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function apiResponse(
  ctx: ApiContext,
  data: unknown,
  status = 200,
  bodyForAudit?: unknown,
): Response {
  if (shouldAudit(ctx.request.method)) {
    void recordAudit({
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      keyPrefix: ctx.keyPrefix,
      method: ctx.request.method,
      path: ctx.path,
      status,
      ip: clientIp(ctx.request),
      userAgent: ctx.request.headers.get('user-agent') ?? undefined,
      bodyPreview: previewBody(bodyForAudit),
    });
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...apiIdentityHeaders(ctx) },
  });
}

/** Convenience for "this argument was malformed" responses that DON'T need
 *  to go through the audit log (no write was attempted). */
export function apiError(message: string, status = 400, ctx?: Pick<ApiContext, 'orgId' | 'siteId'>): Response {
  // `ctx` is optional because many callers raise before a site is resolved.
  // Pass it wherever one exists: a 404 is precisely when the caller wants to
  // know which site was consulted, since the thing they asked for may well
  // exist on the site they meant.
  return ctx ? withApiIdentity(ctx, json({ error: message }, status)) : json({ error: message }, status);
}

/**
 * Resolve every site a token can act on, together with its permission level.
 * Used by the hosted MCP route to build the per-tool-call `siteId ∈ allowed`
 * guard. For site-scoped tokens this is a single-entry list with permission
 * `'admin'`; for org-scoped tokens it's all owned sites + shared-in sites
 * (with each share's permission carried through).
 */
export async function listAllowedSites(
  tokenOrgId: string,
  tokenSiteId: string | null,
): Promise<Array<{
  siteId: string;
  ownerOrgId: string;
  permission: SharePermission;
  site: Site & { id: string };
}>> {
  const store = getStore();
  if (tokenSiteId !== null) {
    const site = await store.getDoc<Site>(paths.site(tokenOrgId, tokenSiteId));
    if (!site) return [];
    return [{ siteId: tokenSiteId, ownerOrgId: tokenOrgId, permission: 'admin', site }];
  }
  const owned = await store.listDocs<Site>(paths.sites(tokenOrgId));
  const shared = await hydrateSharedSites(tokenOrgId);
  return [
    ...owned.map((s) => ({
      siteId: s.id,
      ownerOrgId: tokenOrgId,
      permission: 'admin' as const,
      site: s,
    })),
    ...shared.map(({ site, share }) => ({
      siteId: site.id,
      ownerOrgId: share.owner_org_id,
      permission: share.permission,
      site,
    })),
  ];
}
