// Writing SiteSettings.handover (shared/src/site-handover.ts), for the v1
// settings PATCH and the portal's settings route.
//
// The object is replaced whole, never merged like `fonts`: the checklist is a
// list whose order and removals matter, so a partial update would be
// ambiguous. `null` removes it. Writing it needs design rights on the site
// (administrators and builders), or an app installation with the
// `site:handover` scope.

import { siteHandoverErrors, type SiteHandover } from '@typeroll/shared';
import { vstore } from './version-store';

interface Ctx { orgId: string; siteId: string; versionId: string }

/** Problems with a handover value; `start_page` must name a page of the site. */
export async function handoverWriteErrors(ctx: Ctx, input: unknown): Promise<string[]> {
  const errors = siteHandoverErrors(input);
  if (errors.length || input === null || input === undefined) return errors;
  const startPage = (input as SiteHandover).start_page;
  if (startPage && !(await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, startPage))) return [`handover.start_page "${startPage}" is not a page of this site`];
  return [];
}

/** The stored form: the object as sent (validated), or undefined to remove it. */
export function normalizedHandover(input: unknown): SiteHandover | undefined {
  if (input === null || input === undefined) return undefined;
  const h = input as SiteHandover;
  return {
    ...(h.lock_structure !== undefined ? { lock_structure: h.lock_structure } : {}),
    ...(h.start_page ? { start_page: h.start_page } : {}),
    ...(h.checklist ? { checklist: h.checklist.map(item => ({ id: item.id, label: item.label.trim(), ...(item.done !== undefined ? { done: item.done } : {}), ...(item.href ? { href: item.href } : {}) })) } : {}),
    ...(h.handed_over_at ? { handed_over_at: h.handed_over_at } : {}),
  };
}
