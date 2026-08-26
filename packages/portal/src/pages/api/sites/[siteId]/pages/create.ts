import type { APIRoute } from 'astro';
import { vstore } from '../../../../../lib/version-store';
import { requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, slugify } from '@typeroll/shared';
import type { Page } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, redirect, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim();
  if (!title) return new Response('title is required', { status: 400 });

  const store = getStore();
  const existing = await vstore.pages(owner_org_id, site.id, versionId);

  // De-dupe slug.
  const baseSlug = slugify(title) || 'page';
  let slug = baseSlug;
  let i = 2;
  while (existing.some((p) => p.slug === slug)) {
    slug = `${baseSlug}-${i++}`;
  }

  // Blocks mode is the default. New pages seed with a heading + prose
  // block so the editor isn't a blank canvas. Callers that want HTML
  // mode can pass content_mode=html via the form (used by the new-page
  // dialog's "advanced" toggle) or PATCH it afterwards.
  const requestedMode = String(form.get('content_mode') ?? '').toLowerCase();
  const contentMode: 'blocks' | 'html' = requestedMode === 'html' ? 'html' : 'blocks';

  const pageId = slug;
  const doc: Partial<Page> = {
    title,
    slug,
    content_mode: contentMode,
    status: 'draft',
    date_updated: new Date().toISOString(),
  };
  if (contentMode === 'html') {
    doc.html_content = `<h1>${escapeHtml(title)}</h1><p>Start writing…</p>`;
  } else {
    doc.blocks = [
      {
        id: `blk_${Math.random().toString(36).slice(2, 14)}`,
        type: 'core/heading',
        data: { text: title, level: 'h1', align: 'left', eyebrow: '' },
      },
      {
        id: `blk_${Math.random().toString(36).slice(2, 14)}`,
        type: 'core/prose',
        data: { html: '<p>Start writing…</p>', max_width: 'normal' },
      },
    ];
  }
  await store.setDoc(`${paths.pages(owner_org_id, site.id, versionId)}/${pageId}`, doc);

  return redirect(`/app/sites/${site.id}/pages/${pageId}`);
};

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
