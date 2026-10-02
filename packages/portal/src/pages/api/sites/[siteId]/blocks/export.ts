// GET /api/sites/{siteId}/blocks/export?ids=a,b,c&name=foo&version=1.0.0
//
// Stream a .tcblocks zip of the specified block-type ids. When `ids` is
// omitted, every site block type is included (made in the portal, by an
// agent or imported), read through the version chain so a branch exports
// what it inherits. The package keeps every property (composition, CSS
// scope, field help …). Optional `format=json` returns a JSON payload with
// the zip base64-encoded — used by the MCP server so the agent doesn't have
// to fish bytes out of a Response stream.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { packBlockTypes } from '../../../../../lib/block-packages';
import { exportableBlockTypes } from '../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;

  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');
  const wantedIds = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const pkgName = url.searchParams.get('name') ?? `${site.id}-blocks`;
  const pkgVersion = url.searchParams.get('version') ?? '1.0.0';
  const format = url.searchParams.get('format') ?? 'zip';

  const all = await vstore.blockTypes(owner_org_id, site.id, versionId);
  const filtered = exportableBlockTypes(all, wantedIds);

  if (filtered.length === 0) {
    // 200 with empty payload (matches the v1 endpoint behaviour) — lets
    // idempotent backup flows download/export without special-casing
    // "site has no custom blocks yet". For JSON callers, return the
    // empty manifest. For zip callers (the editor's download button),
    // serve an empty-but-valid zip with just manifest.json inside.
    if (format === 'json') {
      return json({
        manifest: { name: pkgName, version: pkgVersion, blocks: [] },
        zip_base64: null,
        size_bytes: 0,
        block_count: 0,
        note: wantedIds
          ? `None of the requested ids (${wantedIds.join(', ')}) match.`
          : 'This site has no user-created block types yet.',
      });
    }
    // Browser case: download an empty zip so the button doesn't show an
    // error dialog. The manifest is enough for it to be a valid .tcblocks.
    const buf = await packBlockTypes({
      manifest: { name: pkgName, version: pkgVersion },
      block_types: [],
    });
    const safeName = `${pkgName}-${pkgVersion}.tcblocks`.replace(/[^a-zA-Z0-9._-]/g, '_');
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': String(buf.byteLength),
      },
    });
  }

  const buf = await packBlockTypes({
    manifest: { name: pkgName, version: pkgVersion },
    block_types: filtered,
  });

  if (format === 'json') {
    return json({
      manifest: { name: pkgName, version: pkgVersion, blocks: filtered.map((b) => b.name) },
      zip_base64: buf.toString('base64'),
      size_bytes: buf.byteLength,
      block_count: filtered.length,
    });
  }

  const safeName = `${pkgName}-${pkgVersion}.tcblocks`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(buf.byteLength),
    },
  });
};
