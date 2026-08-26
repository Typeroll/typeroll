import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../../lib/access';
import { renderPreviewBySlug } from '../../../../../../lib/render-preview';
import { liveBaseFor } from '../../../../../../lib/site-urls';
import { PREVIEW_SANDBOX } from '../../../../../../lib/preview-headers';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

/**
 * Navigable site preview. Resolves the URL slug against the active version's
 * pages (including drafts) and renders. Internal links inside the rendered
 * HTML are rewritten back into this endpoint so clicking around keeps the
 * user inside the preview surface and continues to see unpublished edits.
 *
 * The banner at the top makes the preview state explicit (which version,
 * which page status, link to live if it exists).
 */
export const GET: APIRoute = async ({ cookies, params, request, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;

  // params.slug is "" for root, "about" for /about, "blog/post" for /blog/post.
  const raw = (params.slug ?? '') as string;
  const slugParts = raw.split('/').filter(Boolean);

  // ?embed=1 means we're being rendered inside the editor iframe — suppress
  // the floating banner because the editor already has its own toolbar; two
  // would be confusing. Internal links keep the same embed mode so the user
  // can navigate the site preview inside the iframe without the banner
  // popping in and out.
  const url = new URL(request.url);
  const embed = url.searchParams.get('embed') === '1';
  const canvasId = embed && /^[A-Za-z0-9_-]{16,128}$/.test(url.searchParams.get('canvas') ?? '')
    ? url.searchParams.get('canvas')!
    : undefined;
  const interactive = embed && url.searchParams.get('interactive') === '1';
  // ?draft=1 shows the working-copy view in a normal tab (banner intact) —
  // used by chat-AI action links so "look at what I changed" shows the
  // unsaved draft the AI just wrote.
  const draft = url.searchParams.get('draft') === '1';
  const browseRoot = `/api/sites/${site.id}/preview/browse`;
  const activeVersion = await getStore().getDoc<SiteVersion>(
    paths.version(owner_org_id, site.id, versionId),
  );
  const liveBase = liveBaseFor(site, activeVersion);

  const html = await renderPreviewBySlug(owner_org_id, site.id, slugParts, versionId, {
    browseRoot,
    showBanner: !embed,
    liveBase: liveBase ?? undefined,
    embedSuffix: embed ? `?embed=1${canvasId ? `&canvas=${encodeURIComponent(canvasId)}` : ''}${interactive ? '&interactive=1' : ''}` : draft ? '?draft=1' : '',
    // Tag every block root with data-block-id inside the editor iframe so the
    // block editor can hit-test the rendered canvas (drag-onto-page + the drop
    // indicator map a spot on the preview back to a position in the tree).
    // Only for embed — plain/draft previews stay clean.
    annotate: interactive,
    // Inline-edit markers (data-edit spans on text fields) — editor iframe only.
    editable: interactive,
    // The in-editor iframe (embed=1) and explicit draft links (draft=1)
    // overlay unsaved working-copy edits. The plain URL — the Publish
    // menu's Preview button — shows SAVED content, matching the model:
    // edits are drafts, Save makes them visible on the preview address,
    // deploy makes them live.
    includeWorkingCopies: embed || draft,
    // The editor canvas NEVER runs block JS. Everything else is served with
    // the opaque-origin sandbox below, so its scripts can't reach the portal
    // session and fidelity wins.
    //
    // An ownership check is NOT enough here, and that was the first attempt.
    // Block content needs only `write`, so an `editor` can put JS in a
    // core/embed block; when an admin then opens that page in the canvas —
    // same origin, no sandbox, same org, so an ownership gate passes — the
    // editor's code runs with the admin's session and reaches settings,
    // API keys and shares. Same-org is exactly where the role model makes
    // that an escalation rather than a non-event.
    //
    // The fidelity path is one click away and already safe: Publish ▾ →
    // Preview and the chat's ?draft=1 links both run scripts in an opaque
    // origin. Running them in the canvas too is what a postMessage migration
    // would buy, and it isn't worth an escalation in the meantime.
    allowScripts: !embed,
    editorCanvasId: canvasId,
  });
  if (!html) {
    return new Response(
      `<!doctype html><meta charset=utf-8><title>Not found</title><body style="font:14px -apple-system;padding:2rem;background:#fafaf9"><h1>No page at /${escapeHtml(raw)}</h1><p>This URL doesn't match any page on the active version. <a href="${browseRoot}/">Back to home</a>.</p></body>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  // Three modes reach this line and only one of them needs the portal's own
  // origin: `embed=1`, the editor iframe, whose inline editing and block
  // drag-and-drop read `iframe.contentDocument`. The plain preview (Publish ▾
  // → Preview) and the chat's `draft=1` action links are read-only, so they
  // get the opaque-origin sandbox instead — the narrowest split that keeps
  // the editor working. See lib/preview-headers.ts.
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      // All customer preview content runs in an opaque origin. Editor
      // interaction is carried by the authority-free, versioned postMessage
      // bridge instead of parent DOM access.
      'Content-Security-Policy': PREVIEW_SANDBOX,
    },
  });
};

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
