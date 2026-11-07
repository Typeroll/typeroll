// POST /api/sites/create — create a site in the session's organization.
//
//   form post { name, domain? }                        → a blank site, redirect to it (the dashboard form)
//   multipart { name, domain?, language?, package, options? }
//                                                      → a site started from a .typeroll site package
//   JSON { name, domain?, language?, id?, from, options? }
//     from: { site_id, version? } | { collection_entry } → a site started from another site of this
//                                                        organization, or a package of the collection
//
// options: { design?: "full" (default) | "styles" | "content", fonts?, font_licence_confirmed? }.
// A JSON body, a start from a template or `Accept: application/json` answers
// 201 { id, url, site, started_from? }; a plain form post is redirected to
// the new site. Errors answer { error, code }.
// Who may use which source: lib/packages/new-site-requests.ts.

import type { APIRoute } from 'astro';
import { json, requireFullSession } from '../../../lib/access';
import { createSite } from '../../../lib/site-create';
import { parseNewSiteOptions, SiteIdTakenError } from '../../../lib/site-create-input';
import { loadNewSiteSource, parseNewSiteFrom, parseNewSiteImportOptions, type NewSiteFrom } from '../../../lib/packages/new-site-source';
import { sessionNewSiteFrom } from '../../../lib/packages/new-site-requests';
import { packageFailureBody } from '../../../lib/packages/package-requests';
import { PackageError } from '../../../lib/packages/package-zip';
import { PACKAGE_LIMITS } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const type = request.headers.get('content-type') ?? '';
  const isJson = type.includes('application/json');
  const acceptsJson = (request.headers.get('accept') ?? '').includes('application/json');

  try {
    let fields: Record<string, unknown>;
    let from: NewSiteFrom | undefined;
    if (isJson) {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send a JSON object { name, from?, options? }', code: 'site_source_invalid' }, 400);
      fields = body as Record<string, unknown>;
      if (fields.from !== undefined && fields.from !== null) from = await parseNewSiteFrom(fields.from, { allowPackage: false });
    } else {
      const length = Number(request.headers.get('content-length') ?? '');
      if (Number.isFinite(length) && length > PACKAGE_LIMITS.zip_bytes + 1024 * 1024) throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
      const form = await request.formData();
      fields = {};
      for (const [key, value] of form.entries()) if (typeof value === 'string') fields[key] = value;
      const file = form.get('package');
      if (file && typeof file !== 'string') {
        if (file.size > PACKAGE_LIMITS.zip_bytes) throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
        from = { kind: 'package', bytes: new Uint8Array(await file.arrayBuffer()) };
      } else if (typeof fields.from === 'string' && fields.from) {
        let parsed: unknown;
        try { parsed = JSON.parse(fields.from); } catch { return json({ error: 'from must be JSON', code: 'site_source_invalid' }, 400); }
        from = await parseNewSiteFrom(parsed, { allowPackage: false });
      }
    }

    // A plain form post (the blank-site form) is redirected; a JSON body, a template start or Accept: application/json gets JSON.
    const wantsJson = isJson || acceptsJson || from !== undefined;
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    const domain = typeof fields.domain === 'string' ? fields.domain.trim() || undefined : undefined;
    if (!name) return wantsJson ? json({ error: 'name is required', code: 'name_required' }, 400) : new Response('name is required', { status: 400 });
    const parsed = parseNewSiteOptions({
      ...(typeof fields.id === 'string' && fields.id ? { id: fields.id } : {}),
      ...(typeof fields.language === 'string' && fields.language ? { language: fields.language } : {}),
    });
    if (parsed.error !== undefined) return json({ error: parsed.error, code: 'site_options_invalid' }, 400);

    let start: Parameters<typeof createSite>[0]['from'];
    if (from) {
      const options = parseNewSiteImportOptions(fields.options);
      const allowed = await sessionNewSiteFrom(cookies, session, from);
      start = { source: await loadNewSiteSource(session.orgId, allowed, options), options };
    }
    const { siteId, site, started_from } = await createSite({
      orgId: session.orgId, name, domain, ...(parsed.id ? { id: parsed.id } : {}), ...(parsed.language ? { language: parsed.language } : {}),
      ...(start ? { from: start } : {}), actor: session.email || session.userId,
    });
    if (!wantsJson) return redirect(`/app/sites/${siteId}`);
    return json({ id: siteId, url: `/app/sites/${encodeURIComponent(siteId)}`, site: { id: siteId, name: site.name, language: site.language ?? 'en' }, ...(started_from ? { started_from } : {}) }, 201);
  } catch (error) {
    if (error instanceof SiteIdTakenError) return json({ error: error.message, code: error.code }, 409);
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
