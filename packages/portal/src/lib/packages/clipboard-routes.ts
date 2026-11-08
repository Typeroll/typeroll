// Who may read the site copied blocks came from, decided with the caller's
// own session or key, for the paste routes (session and v1).

import type { AstroCookies } from 'astro';
import { requireSiteAccess } from '../access';
import { requireApiKey, type ApiContext } from '../api-auth';
import type { SourceAccess } from './clipboard';

/** The same session's access: an owned site, or one shared with the person's organization. */
export function sessionSourceAccess(cookies: AstroCookies): SourceAccess {
  return async (siteId) => {
    const guard = await requireSiteAccess(cookies, siteId);
    return guard.ok ? { orgId: guard.value.owner_org_id } : null;
  };
}

/**
 * The same key's access, resolved as a read of that site would be: an
 * organization key reaches the organization's sites and those shared with
 * it, a site key only its own site, a personal connection what the person's
 * role allows in the organization it names.
 */
export function apiSourceAccess(ctx: ApiContext): SourceAccess {
  return async (siteId) => {
    if (siteId === ctx.siteId) return { orgId: ctx.orgId };
    const url = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}/clipboard/source`, ctx.request.url);
    const guard = await requireApiKey(new Request(url, { method: 'GET', headers: ctx.request.headers }), siteId);
    return guard.ok && !guard.value.extensionIdentity ? { orgId: guard.value.orgId } : null;
  };
}

/** What the audit log keeps of a paste: where it went, not the clipboard. */
export const pasteAuditBody = (body: unknown) => {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return Object.fromEntries(['page_id', 'after_block_id', 'position', 'parent_id', 'slot_index'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
};
