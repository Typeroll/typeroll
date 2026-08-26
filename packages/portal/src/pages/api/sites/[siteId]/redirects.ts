import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Redirect } from '@typeroll/shared';
import { checkRedirectWrite, redirectDocId } from '../../../../lib/redirect-write';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const from_path = normalize(String(form.get('from_path') ?? ''));
  const to_path = normalize(String(form.get('to_path') ?? ''));
  const status_code = Number(form.get('status_code') ?? 301) as 301 | 302;
  if (!from_path || !to_path) return new Response('from_path and to_path required', { status: 400 });

  const check = await checkRedirectWrite({
    orgId: owner_org_id, siteId: site.id, versionId, from_path, to_path,
  });
  if (!check.ok) return new Response(check.error, { status: 400 });

  const doc: Omit<Redirect, 'id'> = {
    from_path,
    to_path,
    status_code,
    auto_generated: false,
  };
  const safeId = redirectDocId(from_path);
  await getStore().setDoc(`${paths.redirects(owner_org_id, site.id, versionId)}/${safeId}`, doc);
  return redirect(`/app/sites/${site.id}/redirects`);
};

function normalize(p: string): string {
  p = p.trim();
  if (!p) return '';
  if (!p.startsWith('/') && !p.startsWith('http')) p = '/' + p;
  return p;
}
