// Centralized auth, authorization, and JSON-response helpers used by every
// API route. Routes call requireSession() / requireSiteAccess() and short-
// circuit if a Response comes back instead of the resource.
//
// Why: the API used to repeat the same 5-line "load session, return 401, load
// site, return 404" boilerplate per route, with subtle inconsistencies (some
// routes returned plain text, others JSON). Centralizing this also makes the
// org/tenant ownership check unmissable — every route that takes a siteId
// MUST call requireSiteAccess and use the site doc it returns, not the
// session.orgId alone, because that's the only way to guarantee the site
// actually belongs to the user's org.

import type { AstroCookies } from 'astro';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { MemberRole, Site, SiteShare, SharePermission, SiteVersion } from '@typeroll/shared';
import { getSession, isPendingSession, type Session } from './auth';
import { getStore } from './datastore';
import { resolveOwnerOrgAccess } from './member-role';

export type GuardResult<T> = { ok: true; value: T } | { ok: false; response: Response };

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function requireSession(cookies: AstroCookies): Promise<GuardResult<Session>> {
  const session = await getSession(cookies);
  if (!session) return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  return { ok: true, value: session };
}

/**
 * Like requireSession but also asserts that orgId is set (rejects pending
 * sessions with 403). Use this in API routes that are org-scoped but don't
 * take a siteId (and thus can't use requireSiteAccess).
 */
export async function requireFullSession(cookies: AstroCookies): Promise<GuardResult<FullSession>> {
  const result = await requireSession(cookies);
  if (!result.ok) return result;
  if (isPendingSession(result.value)) {
    return { ok: false, response: json({ error: 'Organization not set up. Visit /onboarding.' }, 403) };
  }
  return { ok: true, value: result.value as FullSession };
}

/**
 * Resolve the active version for a site, falling back to main if the requested
 * id doesn't exist on this site. Used by requireSiteAccess so every guard
 * yields a trusted `versionId` that callers can pass straight into
 * paths.pages/etc.
 *
 * Defense-in-depth: the requested id is rejected unless it matches the
 * branch-id grammar enforced at create time (kebab-case ASCII, max 64).
 * Today the fixtures store's `path.resolve()` guard and Firestore's literal-
 * segment semantics would already contain any traversal-shaped input — but
 * the allowlist keeps a future, less paranoid store from inheriting a hole.
 */
const VERSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function resolveVersionId(
  orgId: string,
  siteId: string,
  requested: string | undefined,
): Promise<string> {
  const id = (requested ?? MAIN_VERSION_ID).trim() || MAIN_VERSION_ID;
  if (id === MAIN_VERSION_ID) return MAIN_VERSION_ID;
  if (!VERSION_ID_RE.test(id)) return MAIN_VERSION_ID;
  const doc = await getStore().getDoc<SiteVersion>(paths.version(orgId, siteId, id));
  return doc ? id : MAIN_VERSION_ID;
}

/**
 * A Session narrowed so that orgId is guaranteed to be a string.
 * requireSiteAccess returns this so callers can use session.orgId safely.
 */
export type FullSession = Session & { orgId: string };

export type SiteContext = {
  session: FullSession;
  site: Site & { id: string };
  versionId: string;
  /**
   * What the session is allowed to do on this site. For an owned site this
   * comes from the caller's org role (`'admin'` unless the org opted into
   * `roles_enforced` — see lib/member-role.ts); otherwise it's the permission
   * level from the matching SiteShare.
   */
  permission: SharePermission;
  /**
   * The caller's org role, when it was actually consulted — i.e. an owned
   * site in an org with enforcement on. Undefined for shared-in sites (a
   * share grants permission directly, without reference to the recipient
   * org's internal roles) and for orgs that haven't opted in. Present for
   * display; authorization decisions belong to `permission`.
   */
  role?: MemberRole;
  /**
   * Org that owns the site. Equal to session.orgId for owned sites, otherwise
   * the share's owner_org_id. ALL datastore paths inside a site MUST be built
   * with this id — using session.orgId silently misroutes reads/writes when
   * the site is shared in. The "use guard.value.owner_org_id" discipline is
   * the shared-site equivalent of "use site.id, not params.siteId".
   */
  owner_org_id: string;
  /**
   * True when the caller's own org owns this site (as opposed to reaching it
   * through a SiteShare). Computed here so routes never have to compare
   * `session.orgId` themselves — that comparison reads exactly like the
   * misrouted-datastore-path bug the org-id discipline test greps for, and
   * the distinction belongs in the guard rather than in every caller.
   *
   * Used where "can this session act as the site's owner" differs from "may
   * this session read/write": the editor preview renders block JS only for
   * owners, because preview runs on the portal's origin.
   */
  is_owner: boolean;
};

/**
 * Gate an ORG-level route (one with no siteId, so requireSiteAccess can't
 * run) on the caller holding admin authority in their own org.
 *
 * This exists because org-scoped API keys are a privilege-escalation path
 * around the site-level role check: a key minted here carries `permission:
 * 'admin'` over every site the org owns plus every site shared into it
 * (see api-auth.ts → resolveTokenSite). An editor who can mint one has
 * simply routed around `requirePermission(ctx, 'admin')` on all 47 site
 * routes. Any future org-level mutation should use this too.
 */
export async function requireOrgAdmin(
  session: FullSession,
): Promise<GuardResult<FullSession>> {
  const { permission } = await resolveOwnerOrgAccess(session.orgId, session.userId);
  if (permission !== 'admin') {
    return { ok: false, response: json({ error: 'Insufficient permission' }, 403) };
  }
  return { ok: true, value: session };
}

/**
 * Permission ordering — higher number = more authority. Used by
 * requirePermission to compare a context's permission against the level a
 * mutating route demands. Owner-org users always carry `'admin'` here.
 */
const PERMISSION_RANK: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };

/**
 * Gate a route on a minimum permission level. Pair with requireSiteAccess in
 * any mutating handler:
 *
 *   const guard = await requireSiteAccess(cookies, params.siteId);
 *   if (!guard.ok) return guard.response;
 *   const write = requirePermission(guard.value, 'write');
 *   if (!write.ok) return write.response;
 *   const { owner_org_id } = guard.value;  // use this for paths.*()
 */
export function requirePermission(
  ctx: SiteContext,
  required: SharePermission,
): GuardResult<SiteContext> {
  if (PERMISSION_RANK[ctx.permission] < PERMISSION_RANK[required]) {
    return { ok: false, response: json({ error: 'Insufficient permission' }, 403) };
  }
  return { ok: true, value: ctx };
}

/**
 * Look up a share granting `orgId` access to `siteId`. Returns the canonical
 * record from the owner's collection (the flat index is just the discovery
 * hop — its body is duplicated and could be stale). A revoked share is
 * treated as no share at all.
 */
async function resolveShare(
  recipientOrgId: string,
  siteId: string,
): Promise<SiteShare | null> {
  const store = getStore();
  const indexEntries = await store.listDocs<SiteShare>(paths.sharesWithOrg(recipientOrgId));
  const indexEntry = indexEntries.find(
    (s) => s.site_id === siteId && !s.revoked_at,
  );
  if (!indexEntry) return null;
  // Re-fetch the canonical record so a stale index can't grant access.
  const canonical = await store.getDoc<SiteShare>(
    paths.share(indexEntry.owner_org_id, siteId, indexEntry.id),
  );
  if (!canonical || canonical.revoked_at) return null;
  if (canonical.shared_with_org_id !== recipientOrgId) return null;
  return canonical;
}

/**
 * Like requireSiteAccess but for Astro pages — returns either the resolved
 * context or the redirect URL the page should send the user to. Use as:
 *
 *   const ctx = await loadSiteContext(Astro);
 *   if ('redirect' in ctx) return Astro.redirect(ctx.redirect);
 *   const { session, site, versionId } = ctx;
 */
export async function loadSiteContext(
  astro: { cookies: AstroCookies; params: Record<string, string | undefined>; locals: App.Locals },
): Promise<SiteContext | { redirect: string }> {
  const siteId = astro.params.siteId;
  const sessionResult = await requireSession(astro.cookies);
  if (!sessionResult.ok) return { redirect: '/login' };
  const session = sessionResult.value;
  // Pending session (no org) → middleware should have redirected; guard here too.
  if (isPendingSession(session)) return { redirect: '/onboarding' };
  if (!siteId) return { redirect: '/app' };
  const ctx = await resolveSiteContext(session as FullSession, siteId, astro.locals.versionId);
  return ctx ?? { redirect: '/app' };
}

/**
 * The one site-resolution path, shared by requireSiteAccess (API routes,
 * answers with Responses) and loadSiteContext (Astro pages, answers with
 * redirects). Returns null when the site is neither owned nor shared in —
 * each caller renders that refusal in its own idiom.
 *
 * Deliberately one function: these were two copies, and the copy behind
 * loadSiteContext silently missed org-role enforcement when it landed, so
 * pages would have rendered admin affordances to an editor whose API calls
 * then 403'd.
 */
async function resolveSiteContext(
  session: FullSession,
  siteId: string,
  requestedVersionId: string | undefined,
): Promise<SiteContext | null> {
  // Reading the site at the user's org path is the primary authorization
  // check: if the site exists there, the user's org owns it. Firestore
  // security rules can (and should) layer additional checks for direct DB
  // access, but every path-mediated read/write goes through this code path.
  let site = await getStore().getDoc<Site & { id: string }>(paths.site(session.orgId, siteId));
  let permission: SharePermission = 'admin';
  let role: MemberRole | undefined;
  let owner_org_id = session.orgId;

  if (site) {
    // Owned site — authority comes from the caller's org role. Resolves to
    // 'admin' (today's behaviour) unless the org opted into enforcement.
    const access = await resolveOwnerOrgAccess(session.orgId, session.userId);
    permission = access.permission;
    role = access.role;
  } else {
    // Fall back to the cross-org share index. A site not owned by this org
    // may still be reachable via a SiteShare granting the session's org some
    // level of access. Returning null here doubles as the cross-tenant access
    // denial — callers can't distinguish "doesn't exist" from "not yours".
    const share = await resolveShare(session.orgId, siteId);
    if (!share) return null;
    site = await getStore().getDoc<Site & { id: string }>(paths.site(share.owner_org_id, siteId));
    if (!site) return null;
    permission = share.permission;
    owner_org_id = share.owner_org_id;
  }

  const versionId = await resolveVersionId(owner_org_id, siteId, requestedVersionId);
  return {
    session, site, versionId, permission, role, owner_org_id,
    is_owner: owner_org_id === session.orgId,
  };
}

export async function requireSiteAccess(
  cookies: AstroCookies,
  siteId: string | undefined,
  locals?: Pick<App.Locals, 'versionId'>,
): Promise<
  GuardResult<SiteContext>
> {
  if (!siteId) return { ok: false, response: json({ error: 'Missing siteId' }, 400) };
  const sessionResult = await requireSession(cookies);
  if (!sessionResult.ok) return sessionResult;

  // A pending session (no org) cannot access any site.
  if (isPendingSession(sessionResult.value)) {
    return { ok: false, response: json({ error: 'Organization not set up' }, 403) };
  }

  const ctx = await resolveSiteContext(
    sessionResult.value as FullSession, siteId, locals?.versionId,
  );
  if (!ctx) return { ok: false, response: json({ error: 'Site not found' }, 404) };
  return { ok: true, value: ctx };
}
