import { pageAuthorityFields, pageContentValues, PAGE_BUILTIN_FIELDS } from '@typeroll/shared';
// The edit surface behind a one-time link. PUBLIC, but every request is
// bound to a single stored grant.
//
//   GET  ?t=<token>  — redeem: consume the grant, set a scoped cookie, return
//                      the listing's owner-writable fields
//   GET  (cookie)    — read the same payload again on reload
//   PUT  (cookie)    — write those fields, as actor 'owner'
//
// Two properties hold this together:
//
//   1. The collection and item come from the STORED grant, never from the
//      request. A holder can't retarget a valid link at a neighbouring
//      business by editing a parameter.
//   2. Writes go through applyFieldAuthority as `owner`, so the schema
//      whitelist AND the per-field writable_by list both apply. A field that
//      didn't opt into owner-writability is untouchable here even though the
//      session is otherwise valid.

import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { ContentType, SiteApps } from '@typeroll/shared';
import { getStore } from '../../../../lib/datastore';
import { vstore } from '../../../../lib/version-store';
import { directoryConfig } from '../../../../lib/apps/directory';
import {
  EditGrantError,
  buildGrantToken,
  parseGrantToken,
  redeemGrant,
} from '../../../../lib/edit-grants';
import {
  PROVENANCE_KEY,
  applyFieldAuthority,
  conflictResponse,
  writableBy,
} from '../../../../lib/field-authority';
import { validatePageFields } from '../../../../lib/page-fields';
import { markSiteDirty } from '../../../../lib/auto-deploy';

import { publishingRuntimeOrigins } from '../../../../lib/publishing/runtime-origins';

const COOKIE = 'tr_directory_edit';

/**
 * The site's own public origins. Used for CORS so the edit form can live on
 * the customer's domain and call the portal DIRECTLY — no Pages Function, no
 * deploy needed before the app works.
 *
 * Computed from the site doc rather than an allowlist anyone maintains: the
 * portal already knows which domain belongs to which site, so the set can't
 * drift out of sync with reality.
 */
function allowedOrigins(site: { domain?: string; hosting_config?: { fallback_subdomain?: string } }): string[] {
  const out: string[] = [];
  if (site.domain) out.push(`https://${site.domain}`, `https://www.${site.domain}`);
  if (site.hosting_config?.fallback_subdomain) out.push(`https://${site.hosting_config.fallback_subdomain}`);
  return out;
}

function corsHeaders(request: Request, origins: string[]): Record<string, string> {
  const origin = request.headers.get('origin');
  // Echo only an origin we recognise — never `*`, since these responses are
  // credentialed and carry the listing's contents.
  if (!origin || !origins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(data: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

/**
 * The session cookie is a token over the SAME grant id, re-signed after the
 * grant is consumed. So the link dies on first use while the browser that
 * used it keeps working — a forwarded URL is dead, the recipient's tab isn't.
 */
async function loadSession(
  cookies: { get(name: string): { value: string } | undefined },
  siteId: string,
  url: URL,
  request?: Request,
): Promise<{ orgId: string; content_type: string; pageId: string; token: string }> {
  const fresh = url.searchParams.get('t');
  if (fresh) {
    const { orgId, grant } = await redeemGrant(fresh, { consume: true });
    return {
      orgId, content_type: grant.content_type, pageId: grant.page_id,
      token: buildGrantToken(orgId, siteId, grant.id),
    };
  }
  // The static customer page carries the session as a bearer token when it
  // calls the portal directly. A portal-origin cookie remains supported for
  // portal-hosted flows, but customer deployments never receive a proxy.
  const bearer = request?.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const cookie = bearer || cookies.get(COOKIE)?.value;
  const parsed = parseGrantToken(cookie);
  if (!parsed || parsed.siteId !== siteId) {
    throw new EditGrantError('No active editing session', 401);
  }
  const grant = await getStore().getDoc<import('@typeroll/shared').EditGrant>(
    paths.editGrant(parsed.orgId, parsed.siteId, parsed.grantId),
  );
  // A revoked grant kills the live session too, which is the whole point of
  // storing grants — an operator can cut someone off mid-edit.
  if (!grant || grant.revoked_at) throw new EditGrantError('No active editing session', 401);
  return { orgId: parsed.orgId, content_type: grant.content_type, pageId: grant.page_id, token: cookie! };
}

async function loadContentType(
  orgId: string, siteId: string, content_type: string,
): Promise<ContentType> {
  const apps = await getStore().getDoc<SiteApps>(paths.apps(orgId, siteId));
  const cfg = directoryConfig(apps ?? undefined);
  // Disabling the app must close the door on sessions already in flight.
  if (!cfg || cfg.content_type !== content_type) {
    throw new EditGrantError('Editing is not available for this site', 403);
  }
  const coll = await vstore.contentType(orgId, siteId, 'main', content_type);
  if (!coll) throw new EditGrantError('Listing not found', 404);
  return coll;
}

/** Only the fields this surface may write are ever shown or accepted. */
function ownerFields(coll: ContentType) {
  return pageAuthorityFields(coll).filter((f) => writableBy(f).includes('owner'));
}

export const GET: APIRoute = async ({ request, params, cookies }) => {
  const siteId = params.siteId;
  if (!siteId) return json({ error: 'Missing siteId' }, 400);
  try {
    const url = new URL(request.url);
    const sess = await loadSession(cookies, siteId, url, request);
    const coll = await loadContentType(sess.orgId, siteId, sess.content_type);
    const item = await vstore.page(sess.orgId, siteId, 'main', sess.pageId);
    if (!item || item.content_type !== sess.content_type) throw new EditGrantError('Listing not found', 404);

    if (url.searchParams.get('t')) {
      cookies.set(COOKIE, sess.token, {
        path: `/api/directory/${siteId}`,
        httpOnly: true,
        sameSite: 'strict',
        secure: true,
        maxAge: 60 * 60,
      });
    }

    const fields = ownerFields(coll);
    const data = pageContentValues(item);

    // Prefill sources fill fields the RECORD has no value for — they never
    // override it. A source resolves values, never WHICH record: the listing
    // is fixed by the stored grant above, and the only query parameter this
    // route reads is the signed token. So `?page_id=someone-else` changes
    // nothing, and a source can't be pointed at another business either.
    const formDoc = await getStore().getDoc<import('@typeroll/shared').Form>(
      `${paths.forms(sess.orgId, siteId)}/${url.searchParams.get('form') ?? ''}`,
    ).catch(() => null);
    let extra: Record<string, unknown> = {};
    if (formDoc?.prefill?.length) {
      const { resolvePrefill } = await import('../../../../lib/forms/prefill');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) if (k !== 't') query[k] = v;
      const resolved = await resolvePrefill(
        formDoc,
        { orgId: sess.orgId, siteId, query, sessionToken: sess.token },
        fields.map((f) => f.name),
      );
      extra = resolved.values;
    }
    return json({
      listing_id: sess.pageId,
      // Handed back so a cross-origin form can carry the session in a header
      // instead of a cookie. Same value the cookie holds; the grant is already
      // consumed, so this authorises the session and nothing more.
      session_token: sess.token,
      fields: fields.map((f) => ({
        name: f.name, label: f.label, type: f.type, required: f.required === true,
        // Record first, prefill only where the record is empty.
        options: f.options,
        value: data[f.name] ?? extra[f.name] ?? null,
      })),
    }, 200, await cors(sess.orgId, siteId, request));
  } catch (e) {
    if (e instanceof EditGrantError) {
      return json({ error: e.message }, e.status, await corsAnon(siteId, request));
    }
    throw e;
  }
};

/** CORS headers once the owning org is known. */
async function cors(orgId: string, siteId: string, request: Request) {
  const site = await getStore().getDoc<{ publishing_mode?: string; domain?: string; hosting_config?: { fallback_subdomain?: string } }>(
    paths.site(orgId, siteId),
  );
  return site ? corsHeaders(request, site.publishing_mode === 'customer_git' ? await publishingRuntimeOrigins(orgId, siteId) : allowedOrigins(site)) : {};
}

/**
 * CORS for responses produced BEFORE a session resolved (401s, preflight).
 * Without them the browser hides the status and the form can't tell "your
 * link expired" from "the network is down".
 */
async function corsAnon(siteId: string, request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const store = getStore();
  for (const org of await store.listDocs<{ id: string }>('organizations')) {
    const site = await store.getDoc<{ publishing_mode?: string; domain?: string; hosting_config?: { fallback_subdomain?: string } }>(
      paths.site(org.id, siteId),
    );
    if (site) return corsHeaders(request, site.publishing_mode === 'customer_git' ? await publishingRuntimeOrigins(org.id, siteId) : allowedOrigins(site));
  }
  return {};
}

export const OPTIONS: APIRoute = async ({ request, params }) => {
  const siteId = params.siteId;
  if (!siteId) return new Response(null, { status: 400 });
  return new Response(null, { status: 204, headers: await corsAnon(siteId, request) });
};

/** Shared write path for both request shapes. */
async function applyEdit(
  siteId: string,
  cookies: Parameters<typeof loadSession>[0],
  request: Request,
  incomingRaw: Record<string, unknown>,
  fromForm = false,
) {
  const sess = await loadSession(cookies, siteId, new URL(request.url), request);
  const coll = await loadContentType(sess.orgId, siteId, sess.content_type);
  const existing = await vstore.page(
    sess.orgId, siteId, 'main', sess.pageId,
  );
  if (!existing || existing.content_type !== sess.content_type) throw new EditGrantError('Listing not found', 404);

  // Schema whitelist first, then authority. `status` is deliberately absent
  // from both — a business editing its own details must not be able to
  // publish or unpublish its listing.
  const allowed = new Set(ownerFields(coll).map((f) => f.name));
  const incoming: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incomingRaw)) if (allowed.has(k)) incoming[k] = v;

  if (fromForm) for (const field of ownerFields(coll)) {
    if (!(field.name in incoming)) continue;
    const value = incoming[field.name];
    if (field.type === 'multiselect') incoming[field.name] = (Array.isArray(value) ? value : [value]).filter(entry => entry !== '');
    if (field.type === 'number' && typeof incoming[field.name] === 'string') incoming[field.name] = incoming[field.name] === '' ? null : Number(incoming[field.name]);
    if (field.type === 'boolean' && typeof incoming[field.name] === 'string') incoming[field.name] = ['yes', 'true', 'on', '1'].includes(incoming[field.name] as string);
  }
  const invalid = validatePageFields({ ...coll, fields: coll.fields.filter(field => field.name in incoming) }, Object.fromEntries(Object.entries(incoming).filter(([name]) => !PAGE_BUILTIN_FIELDS.has(name))), true);
  if (invalid) throw new EditGrantError(invalid, 400);
  const authority = applyFieldAuthority({
    fields: pageAuthorityFields(coll), incoming, existing,
    actor: 'owner', actorId: `edit-link:${sess.pageId}`,
  });
  if (authority.rejected.length === 0) {
    await vstore.writePage(sess.orgId, siteId, 'main', sess.pageId, {
      ...Object.fromEntries(Object.entries(authority.update).filter(([name]) => PAGE_BUILTIN_FIELDS.has(name))),
      fields: { ...existing.fields, ...Object.fromEntries(Object.entries(authority.update).filter(([name]) => !PAGE_BUILTIN_FIELDS.has(name))) },
      [PROVENANCE_KEY]: authority.provenance,
      date_updated: new Date().toISOString(),
    });
    await markSiteDirty(sess.orgId, siteId);
  }
  return { sess, authority };
}

export const PUT: APIRoute = async ({ request, params, cookies }) => {
  const siteId = params.siteId;
  if (!siteId) return json({ error: 'Missing siteId' }, 400);
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { sess, authority } = await applyEdit(siteId, cookies, request, body);
    const headers = await cors(sess.orgId, siteId, request);
    if (authority.rejected.length > 0) {
      return json(conflictResponse(authority.rejected), 409, headers);
    }
    return json({ ok: true, updated_fields: Object.keys(authority.update) }, 200, headers);
  } catch (e) {
    if (e instanceof EditGrantError) {
      return json({ error: e.message }, e.status, await corsAnon(siteId, request));
    }
    throw e;
  }
};

/**
 * The same write, speaking the FORMS RUNTIME's protocol.
 *
 * This is what lets the edit form be a real Typeroll form rather than
 * hand-written markup: build it in the forms UI out of `form/*` field blocks
 * whose names match the collection's fields, point its action here, and the
 * existing runtime handles submission, per-field error rendering, the
 * honeypot and the site's form styling. FormData in; `{done:true}` or
 * `{ok:false, errors:[{field,message}]}` out — exactly what forms-runtime.ts
 * expects.
 */
export const POST: APIRoute = async ({ request, params, cookies }) => {
  const siteId = params.siteId;
  if (!siteId) return json({ ok: false, errors: [{ message: 'Missing siteId' }] }, 400);
  try {
    const form = await request.formData();
    // The runtime's own control fields never reach the item.
    const incoming: Record<string, unknown> = {};
    for (const k of new Set(form.keys())) {
      if (k.startsWith('_')) continue;
      const values = form.getAll(k).filter((value): value is string => typeof value === 'string');
      incoming[k] = values.length > 1 ? values : values[0];
    }
    // Honeypot, same field the forms runtime already ships in its markup.
    if (String(form.get('_hp') ?? '')) {
      return json({ done: true }, 200, await corsAnon(siteId, request));
    }

    // Pre-submit pass first: an action may veto the write, and unlike the
    // post-submit pass its failure must be visible to the visitor.
    const gate = await (async () => {
      const formId = String(form.get('_form_id') ?? '');
      if (!formId) return { ok: true as const };
      const pre = await loadSession(cookies, siteId, new URL(request.url), request).catch(() => null);
      if (!pre) return { ok: true as const };
      const doc = await getStore().getDoc<import('@typeroll/shared').Form>(
        `${paths.forms(pre.orgId, siteId)}/${formId}`,
      );
      if (!doc) return { ok: true as const };
      const { runBeforeActions } = await import('../../../../lib/forms/actions');
      return runBeforeActions(doc, { orgId: pre.orgId, siteId, data: incoming });
    })();
    if (!gate.ok) {
      return json({ ok: false, errors: [{ message: gate.reason }] }, 200, await corsAnon(siteId, request));
    }

    const { sess, authority } = await applyEdit(siteId, cookies, request, incoming, true);
    const headers = await cors(sess.orgId, siteId, request);
    if (authority.rejected.length === 0) {
      // Whatever the FORM declared, from whichever source — this endpoint
      // knows nothing about emails or Slack, it just asks the registry.
      const formId = String(form.get('_form_id') ?? '');
      if (formId) {
        const doc = await getStore().getDoc<import('@typeroll/shared').Form>(
          `${paths.forms(sess.orgId, siteId)}/${formId}`,
        );
        if (doc) {
          const { runFormActions } = await import('../../../../lib/forms/actions');
          await runFormActions(doc, {
            orgId: sess.orgId, siteId, data: incoming,
            subject: { kind: 'page', content_type: sess.content_type, id: sess.pageId },
          });
        }
      }
    }
    if (authority.rejected.length > 0) {
      // Per-field errors so the runtime highlights the exact inputs that
      // lost, instead of a banner the visitor can't act on.
      return json({
        ok: false,
        errors: authority.rejected.map((r) => ({
          field: r.field,
          message: r.reason === 'not_writable'
            ? 'This field is managed by the directory.'
            : `Updated by ${r.current_source} — contact us to change it.`,
        })),
      }, 200, headers);
    }
    return json({ done: true }, 200, headers);
  } catch (e) {
    if (e instanceof EditGrantError) {
      return json(
        { ok: false, errors: [{ message: e.message }] },
        200, await corsAnon(siteId, request),
      );
    }
    throw e;
  }
};
