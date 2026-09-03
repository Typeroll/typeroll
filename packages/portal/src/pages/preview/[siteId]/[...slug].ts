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
import { verifyPreviewToken } from '../../../lib/preview-signing';
import { rateLimit } from '../../../lib/rate-limit';
import { isolatedPreviewHeaders } from '../../../lib/preview-headers';
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
  const ticket = verifyPreviewToken(token);
  if (!ticket) return plain('<h1>Invalid or expired preview link</h1>', 401);
  if (ticket.site_id !== siteId) return plain('<h1>Invalid preview link</h1>', 401);

  // Rate-limit per token so a runaway scraper can't pull a snapshot loop.
  // 300/min, separate bucket from API key rate-limits.
  const rl = rateLimit(`pv:${token}`, 300, 60_000);
  if (!rl.allowed) {
    return plain(
      '<h1>Preview rate limit exceeded</h1>',
      429,
    );
  }

  const raw = (params.slug ?? '') as string;
  const slugParts = raw.split('/').filter(Boolean);

  // The outer page contains no customer content. It can therefore retain the
  // portal origin safely and own tab-scoped Extension state, while all
  // customer HTML remains in the opaque child response below.
  const isFrame = url.searchParams.get('frame') === '1';
  if (!isFrame) {
    return new Response(buildExtensionPreviewShell({
      siteId,
      bridgeId: randomUUID(),
      rootPath: `/preview/${siteId}`,
      storageScope: token!,
      carriedQuery: { t: token! },
    }), { status: 200, headers: extensionPreviewShellHeaders() });
  }
  const bridgeId = url.searchParams.get('bridge') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(bridgeId)) return plain('<h1>Invalid preview frame</h1>', 400);

  // Link rewriting: keep clicks inside /preview/{siteId}/... AND carry the
  // same ?t= so the agent's browser hops between pages without re-auth.
  const browseRoot = `/preview/${siteId}`;
  const embedSuffix = `?t=${encodeURIComponent(token!)}`;

  const html = await renderPreviewBySlug(
    ticket.org_id,
    ticket.site_id,
    slugParts,
    ticket.version_id,
    {
      browseRoot,
      showBanner: false,
      embedSuffix,
      // Only tokens explicitly minted with include_working_copy render
      // unsaved editor edits — the flag is HMAC-signed into the ticket.
      includeWorkingCopies: ticket.wc === true,
      // Safe despite there being no viewer identity to check: this response
      // carries the opaque-origin sandbox, so its JS has no portal access to
      // abuse. Keeping scripts on means an agent's preview matches the
      // deployed site.
      allowScripts: true,
      extensionPreviewBridge: { id: bridgeId, parentOrigin: url.origin },
    },
  );
  if (!html) {
    return plain(
      `<!doctype html><meta charset=utf-8><title>Not found</title><body style="font:14px -apple-system;padding:2rem"><h1>No page at /${escapeHtml(raw)}</h1></body>`,
      404,
    );
  }
  return plain(html, 200);
};

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
