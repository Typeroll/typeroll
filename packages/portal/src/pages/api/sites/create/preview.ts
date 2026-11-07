// POST /api/sites/create/preview — what a new site would start from, before it is created.
//
//   multipart { package, options? }                     a .typeroll site package
//   JSON { from: { site_id, version? } | { collection_entry }, options? }
//
// → { source, counts, package, signature, language, needs: { font_licence, fonts }, warnings, errors }
//
// Writes nothing. The new-site form shows the publisher, licence, signature
// (an invalid one cannot be used: `errors`) and asks for the font licence
// when `needs.font_licence`. A site copy is previewed without reading its
// media. Same permissions as POST /api/sites/create with that source.

import type { APIRoute } from 'astro';
import { json, requireFullSession } from '../../../../lib/access';
import { loadNewSiteSource, newSiteSourcePreview, parseNewSiteFrom, parseNewSiteImportOptions, previewSiteSource, type NewSiteFrom } from '../../../../lib/packages/new-site-source';
import { sessionNewSiteFrom } from '../../../../lib/packages/new-site-requests';
import { packageFailureBody, packageUpload } from '../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  try {
    let from: NewSiteFrom;
    let rawOptions: unknown;
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return json({ error: 'Send { from, options? }', code: 'site_source_invalid' }, 400);
      from = await parseNewSiteFrom(body.from, { allowPackage: false });
      rawOptions = body.options;
    } else {
      const upload = await packageUpload(request, 'package');
      from = { kind: 'package', bytes: upload.bytes };
      rawOptions = upload.options;
    }
    const options = parseNewSiteImportOptions(rawOptions);
    const allowed = await sessionNewSiteFrom(cookies, session, from);
    if (allowed.kind === 'site') return json(await previewSiteSource(session.orgId, allowed.site_id, allowed.version_id ?? 'main', options));
    return json(newSiteSourcePreview(await loadNewSiteSource(session.orgId, allowed, options, { manifestOnly: true }), options));
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
