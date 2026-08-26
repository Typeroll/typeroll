// POST /api/directory/{siteId}/request-link  — PUBLIC, unauthenticated
//
// "Mail me a link to edit my listing." Third unauthenticated endpoint in the
// codebase, after /api/auth/session and /api/forms/submit, and it follows the
// latter's defence pattern: rate limit, honeypot, and a check that the
// requester already knows something only the listing's owner would.
//
// The check that matters: the link is mailed to the address ALREADY ON THE
// LISTING, and the request must name that same address. A stranger can't have
// a link mailed to a business on their behalf, and can't discover the address
// either — every outcome returns the same 202.

import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { CollectionItem, SiteApps } from '@typeroll/shared';
import { getStore } from '../../../../lib/datastore';
import { vstore } from '../../../../lib/version-store';
import { rateLimit } from '../../../../lib/rate-limit';
import { directoryConfig } from '../../../../lib/apps/directory';
import { issueGrant } from '../../../../lib/edit-grants';
import { sendViaConnector } from '../../../../lib/email';

/**
 * Same body for every outcome — unknown site, disabled app, no such listing,
 * wrong address, rate limited. Anything else turns this endpoint into an
 * oracle for "does this business have an account and what address is on it".
 */
const ACCEPTED = { ok: true, message: 'If that address is on file, a link is on its way.' };

function accepted(): Response {
  return new Response(JSON.stringify(ACCEPTED), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  const siteId = params.siteId;
  if (!siteId) return accepted();

  const body = (await request.json().catch(() => null)) as {
    item_id?: string;
    email?: string;
    _hp?: string;
  } | null;
  if (!body) return accepted();
  // Honeypot — bots fill it, humans never see it. Same field name as
  // /api/forms/submit so a site's existing bot rules cover both.
  if (body._hp) return accepted();

  const email = (body.email ?? '').trim().toLowerCase();
  const itemId = (body.item_id ?? '').trim();
  if (!email || !itemId) return accepted();

  // Two buckets: one per requester so a script can't sweep the directory,
  // one per listing so a business can't be mail-bombed by someone else.
  if (!rateLimit(`dir-req-ip:${clientAddress}`, 10, 10 * 60_000).allowed) return accepted();
  if (!rateLimit(`dir-req-item:${siteId}:${itemId}`, 3, 60 * 60_000).allowed) return accepted();

  try {
    const store = getStore();
    // Org is derived from the site, not supplied: a public caller must never
    // choose which tenant's tree is read.
    const orgId = await resolveOwnerOrg(siteId);
    if (!orgId) return accepted();

    const apps = await store.getDoc<SiteApps>(paths.apps(orgId, siteId));
    const cfg = directoryConfig(apps ?? undefined);
    if (!cfg) return accepted();

    const item = await vstore.collectionItem(orgId, siteId, 'main', cfg.collection, itemId);
    if (!item) return accepted();

    const onFile = String((item as Record<string, unknown>)[cfg.emailField] ?? '')
      .trim().toLowerCase();
    if (!onFile || onFile !== email) return accepted();

    const { token, expiresAt } = await issueGrant({
      orgId, siteId, collection: cfg.collection, itemId, email: onFile, ttlHours: cfg.ttlHours,
    });

    const integrations = await store.getDoc<{ email?: import('@typeroll/shared').EmailConnector }>(
      paths.integrations(orgId, siteId),
    );
    if (!integrations?.email) return accepted();

    // The connector supplies the From address, so the mail carries the
    // directory's own brand rather than Typeroll's — see the plan's §5.
    await sendViaConnector(integrations.email, {
      from: '',
      to: onFile,
      subject: 'Your edit link',
      // Plain text on purpose: an HTML mail template is the site owner's
      // branding decision, and the connector already carries their From
      // address, so this stays the directory's mail either way.
      text:
        `Use this link to update your listing:\n\n${editLinkUrl(siteId, token)}\n\n` +
        `It works once and expires ${new Date(expiresAt).toUTCString()}.\n` +
        `If you didn't ask for it, ignore this message — nothing has changed.`,
    });
  } catch {
    // Delivery failures, missing email connector, datastore hiccups — all
    // indistinguishable from the outside, by design.
  }
  return accepted();
};

/**
 * The URL mailed to the listing owner.
 *
 * MUST point at a route that exists — `session.ts` is what redeems a grant
 * (`GET ?t=<token>`). There is no `/redeem` route; an earlier version of this
 * function pointed at one and every emailed link 404'd. The unit tests call
 * the session handler directly, so routing was never exercised —
 * `request-link-url.test.ts` now pins the path against the filesystem.
 */
function editLinkUrl(siteId: string, token: string): string {
  const base = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  return `${base}${EDIT_LINK_PATH(siteId)}?t=${encodeURIComponent(token)}`;
}

/** Exported so a test can assert a route file backs this path. */
export const EDIT_LINK_PATH = (siteId: string) => `/api/directory/${siteId}/session`;

/**
 * Which org owns this site. Public callers don't supply an org, so this scans
 * — acceptable because the endpoint is heavily rate-limited and the answer is
 * never returned to the caller.
 */
async function resolveOwnerOrg(siteId: string): Promise<string | null> {
  const store = getStore();
  const orgs = await store.listDocs<{ id: string }>('organizations');
  for (const org of orgs) {
    const site = await store.getDoc(paths.site(org.id, siteId));
    if (site) return org.id;
  }
  return null;
}
