// AI chat endpoint.
//
// Security notes worth keeping in mind:
//   - History is rebuilt from server-stored chat_messages, NEVER trusted from
//     the client body. Trusting client history would let a malicious page
//     inject fake "assistant" turns containing prior tool-use approvals.
//   - The user message is persisted BEFORE calling the model so that a 500
//     in the tool loop doesn't lose the question.
//   - Only siteId from the URL is used; the session's orgId is the only
//     authority on which org's data is in scope.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { runChatTurn, type ChatMessageInput, type ActivePageContext } from '../../../../lib/anthropic';
import { vstore } from '../../../../lib/version-store';
import { paths } from '@typeroll/shared';
import type { ChatAttachment, ChatMessage, SiteVersion } from '@typeroll/shared';

const HISTORY_TURNS = 20;

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const siteId = site.id;

  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    attachments?: ChatAttachment[];
    active_page_id?: string;
  };
  const message = (body.message ?? '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 8) : [];
  if (!message && attachments.length === 0) return json({ error: 'Empty message' }, 400);

  // The page editor pins the chat to a single page so "this page", "here",
  // etc. resolve unambiguously. Re-read the page server-side so the prompt
  // can't be spoofed via the client body (e.g. a bogus title/slug).
  let activePage: ActivePageContext | null = null;
  if (typeof body.active_page_id === 'string' && body.active_page_id.trim()) {
    const p = await vstore.page(owner_org_id, siteId, versionId, body.active_page_id.trim());
    if (p) activePage = { id: p.id, title: p.title, slug: p.slug };
  }

  const store = getStore();
  const now = new Date().toISOString();

  // Compose the message the model actually sees: user text plus a tail
  // listing each attached image's CDN URL. The model already knows from
  // the playbook + prompt that it can <img src="..."> these into pages.
  const modelMessage = attachments.length
    ? [
        message || 'See attached image(s).',
        '',
        attachments
          .map((a) => `[Attached image: ${a.cdn_url}${a.filename ? ` (filename: ${a.filename})` : ''}]`)
          .join('\n'),
      ].join('\n')
    : message;

  // Persist the user message first so it survives errors in the tool loop.
  await store.addDoc(paths.chat(owner_org_id, siteId, versionId), {
    user_id: session.userId,
    role: 'user',
    content: message,
    attachments: attachments.length ? attachments : undefined,
    created_at: now,
  });

  // Rebuild history from server state. Filter to this user's own messages
  // so multi-user sites don't leak cross-user context, and drop the message
  // we just persisted (it goes in as the new turn).
  const allMessages = await store.listDocs<ChatMessage>(paths.chat(owner_org_id, siteId, versionId));
  const recent = allMessages
    .filter((m) => m.user_id === session.userId && m.content !== message)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .slice(-HISTORY_TURNS)
    .map<ChatMessageInput>((m) => ({ role: m.role, content: m.content }));

  const version = await store.getDoc<SiteVersion>(paths.version(owner_org_id, siteId, versionId));

  // Origin of the portal itself — used to give the model absolute preview
  // URLs the user can actually click, not bare paths.
  const portalOrigin = new URL(request.url).origin;

  const startedAt = Date.now();
  try {
    const result = await runChatTurn({
      orgId: owner_org_id,
      siteId,
      versionId,
      siteName: site.name,
      site,
      version,
      portalOrigin,
      message: modelMessage,
      history: recent,
      activePage,
    });

    await store.addDoc(paths.chat(owner_org_id, siteId, versionId), {
      user_id: session.userId,
      role: 'assistant',
      content: result.reply,
      actions_taken: result.actions,
      tool_calls: result.tool_calls,
      iterations: result.iterations,
      duration_ms: Date.now() - startedAt,
      created_at: new Date().toISOString(),
    });

    return json({ reply: result.reply, actions: result.actions });
  } catch (e) {
    // Persist the failure too — these are the rows we'll want to dig into.
    await store.addDoc(paths.chat(owner_org_id, siteId, versionId), {
      user_id: session.userId,
      role: 'assistant',
      content: `__error__: ${e instanceof Error ? e.message : 'Chat failed'}`,
      duration_ms: Date.now() - startedAt,
      created_at: new Date().toISOString(),
    });
    return json({ error: e instanceof Error ? e.message : 'Chat failed' }, 500);
  }
};
