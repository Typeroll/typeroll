import type { APIRoute } from 'astro';
import { requireFullSession } from '../../../lib/access';
import { createSite } from '../../../lib/site-create';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const domain = String(form.get('domain') ?? '').trim() || undefined;
  if (!name) return new Response('name is required', { status: 400 });

  const { siteId } = await createSite({ orgId: session.orgId, name, domain });
  return redirect(`/app/sites/${siteId}`);
};
