// GET /preview/{siteId}/{...slug}?t=<signed-token>
//
// Token-auth navigable preview for external agents. The token is minted by
// POST /api/v1/sites/{siteId}/preview-link and signed by lib/preview-signing.
// Verified inline (no DB hit, no session) and bound to one site + version.
//
// Internal links inside the rendered HTML are rewritten so clicking through
// stays in /preview/{siteId}/* AND keeps the same token attached, letting
// the agent's browser-MCP navigate the site without re-minting tokens per
// page.

import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { renderPreviewBySlug } from '../../../lib/render-preview';
import { previewDerivation } from '../../../lib/publishing/preview-derivation';
import { verifyActivePreviewToken } from '../../../lib/preview-signing';
import { rewritePreviewMediaUrls } from '../../../lib/preview-media';
import { rateLimit } from '../../../lib/rate-limit';
import { isolatedPreviewHeaders, publicRequestOrigin } from '../../../lib/preview-headers';
import {
  buildExtensionPreviewShell,
  extensionPreviewShellHeaders,
} from '../../../lib/extensions/preview-shell';

function plain(body: string, status: number, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, {
    status,
    headers: {
      ...isolatedPreviewHeaders(),
      'Content-Type': contentType,
    },
  });
}

export const GET: APIRoute = async ({ params, request }) => {
  const siteId = params.siteId;
  if (!siteId) return plain('<h1>Missing siteId</h1>', 400);
  const url = new URL(request.url);
  const token = url.searchParams.get('t');
  const ticket = await verifyActivePreviewToken(token);
  if (!ticket) return plain('<h1>Invalid or expired preview link</h1>', 401);
  if (ticket.site_id !== siteId) return plain('<h1>Invalid preview link</h1>', 401);

  // Rate-limit per token so a runaway scraper can't pull a snapshot loop.
  // 300/min, separate bucket from API key rate-limits.
  const rl = await rateLimit(`pv:${token}`, 300, 60_000);
  if (!rl.allowed) {
    return plain(
      '<h1>Preview rate limit exceeded</h1>',
      429,
    );
  }

  const raw = (params.slug ?? '') as string;
  const slugParts = raw.split('/').filter(Boolean);

  // The dataset an app derived for this version, as a build writes it to
  // /_typeroll/derived/<sha256>.json. Fetched from the opaque preview frame,
  // so it allows any origin; the token in the URL is the capability.
  const derivedFile = /^_typeroll\/derived\/([0-9a-f]{64})\.json$/.exec(slugParts.join('/'));
  if (derivedFile) {
    const derivation = await previewDerivation(ticket.org_id, ticket.site_id, ticket.version_id, { contentRevision: false });
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (derivation.status === 'failed') return new Response(JSON.stringify({ error: 'derivation_failed', message: derivation.error?.message ?? 'Derivation failed' }), { status: 502, headers });
    // Content changed since the page was rendered: never answer with other data under this name.
    if (derivation.data_digest !== derivedFile[1] || !derivation.data) return new Response(JSON.stringify({ error: 'derived_data_changed', message: 'Content changed since this page was rendered. Reload the preview.' }), { status: 409, headers });
    return new Response(derivation.data, { status: 200, headers });
  }

  // The outer page contains no customer content. It can therefore retain the
  // portal origin safely and own tab-scoped Extension state, while all
  // customer HTML remains in the opaque child response below.
  const isFrame = url.searchParams.get('frame') === '1';
  // ?consent=all|necessary answers the cookie banner for this review session;
  // the sandbox keeps no cookies, so the shell carries it to every page.
  const consentParam = url.searchParams.get('consent');
  const consentChoice = consentParam === 'all' || consentParam === 'necessary' ? consentParam : undefined;
  if (!isFrame) {
    return new Response(buildExtensionPreviewShell({
      siteId,
      bridgeId: randomUUID(),
      rootPath: `/preview/${siteId}`,
      storageScope: token!,
      carriedQuery: { t: token!, ...(consentChoice ? { consent: consentChoice } : {}) },
    }), { status: 200, headers: extensionPreviewShellHeaders() });
  }
  const bridgeId = url.searchParams.get('bridge') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(bridgeId)) return plain('<h1>Invalid preview frame</h1>', 400);

  // Link rewriting: keep clicks inside /preview/{siteId}/... AND carry the
  // same ?t= so the agent's browser hops between pages without re-auth.
  const browseRoot = `/preview/${siteId}`;
  const embedSuffix = `?t=${encodeURIComponent(token!)}${consentChoice ? `&consent=${consentChoice}` : ''}`;

  // Derived data comes from the version's accepted, published content, as its
  // next publication would see it, never from working copies or proposals.
  // A link made with a content revision recomputes it, to say when content changed since.
  const derivation = await previewDerivation(ticket.org_id, ticket.site_id, ticket.version_id, { contentRevision: Boolean(ticket.cr) });
  const derivedDataUrl = derivation.data_digest
    ? `${publicRequestOrigin(request)}${browseRoot}/_typeroll/derived/${derivation.data_digest}.json?t=${encodeURIComponent(token!)}` : '';

  const html = await renderPreviewBySlug(
    ticket.org_id,
    ticket.site_id,
    slugParts,
    ticket.version_id,
    {
    sharedMediaToken: token!,
      browseRoot,
      showBanner: false,
      embedSuffix,
      // Only tokens explicitly minted with include_working_copy render
      // unsaved editor edits — the flag is HMAC-signed into the ticket.
      includeWorkingCopies: ticket.wc === true,
      // Upgrade previews carry the target render version in the signed ticket.
      ...(typeof ticket.rv === 'number' ? { renderVersion: ticket.rv } : {}),
      // Safe despite there being no viewer identity to check: this response
      // carries the opaque-origin sandbox, so its JS has no portal access to
      // abuse. Keeping scripts on means an agent's preview matches the
      // deployed site.
      allowScripts: true,
      ...(consentChoice ? { consentChoice } : {}),
      extensionPreviewBridge: { id: bridgeId, parentOrigin: publicRequestOrigin(request) },
      ...(derivation.status === 'succeeded' ? { derived: { sources: derivation.derived, dataUrl: derivedDataUrl } } : {}),
    },
  );
  if (!html) {
    return plain(
      `<!doctype html><meta charset=utf-8><title>Not found</title><body style="font:14px -apple-system;padding:2rem"><h1>No page at /${escapeHtml(raw)}</h1></body>`,
      404,
    );
  }
  // Private original references stay stable in CMS content. Only this expiring
  // response carries the preview capability; it is never persisted in content or Git.
  // A failed derivation is shown, not rendered as empty listings.
  const noticeStyle = 'position:sticky;top:0;z-index:2147483647;padding:.75rem 1rem;font:14px/1.4 system-ui,sans-serif';
  const notice = (derivation.status === 'failed'
    ? `<div role="alert" data-tr-derivation-error style="${noticeStyle};background:#fff5f5;color:#742a2a;border-bottom:2px solid #c53030">App data could not be derived for this preview, so lists, counts and filters that use it are missing. ${escapeHtml(derivation.error?.message ?? '')}</div>`
    : '') + (ticket.cr && derivation.content_revision && derivation.content_revision !== ticket.cr
    ? `<div role="status" data-tr-content-changed style="${noticeStyle};background:#fffbeb;color:#713f12;border-bottom:2px solid #d97706">Content changed since this preview link was created (revision ${escapeHtml(ticket.cr.slice(0, 12))}, now ${escapeHtml(derivation.content_revision.slice(0, 12))}). This page shows the current content; create new links to compare render versions on identical content.</div>`
    : '');
  return plain(rewritePreviewMediaUrls(notice ? html.replace(/<body[^>]*>/i, match => match + notice) : html, siteId, token!), 200);
};

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
