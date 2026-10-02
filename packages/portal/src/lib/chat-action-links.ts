// Portal editor links for AI chat actions. The chat tool loop knows what it
// changed — a page, a global block, a page template or a block type — so it
// computes the link here instead of the chat UI guessing a page URL from a
// bare target id (which sent block types and headers to a 404).

export type ChatEditKind = 'page' | 'partial' | 'template' | 'block_type';

export interface ChatEditLink {
  /** Portal-relative URL of the editor for the changed item. */
  href: string;
  /** Link text, e.g. "Edit page". */
  link_label: string;
}

const LABELS: Record<ChatEditKind, string> = {
  page: 'Edit page',
  partial: 'Edit global block',
  template: 'Edit template',
  block_type: 'Edit block type',
};

/** The editor link for an item the chat created or changed. */
export function chatEditLink(siteId: string, kind: ChatEditKind, id: string): ChatEditLink {
  const site = `/app/sites/${encodeURIComponent(siteId)}`;
  const ref = encodeURIComponent(id);
  const href =
    kind === 'block_type' ? `${site}/blocks?type=${ref}`
    : kind === 'partial' ? `${site}/partials/${ref}`
    : kind === 'template' ? `${site}/templates/${ref}`
    : `${site}/pages/${ref}`;
  return { href, link_label: LABELS[kind] };
}

/** Action types whose `target` is a page id. */
const PAGE_ACTION_TYPES = new Set([
  'create_page', 'update_page', 'update_page_html', 'update_page_seo', 'update_page_status',
  'add_faq_schema', 'add_recipe_schema', 'add_event_schema',
]);

/**
 * The edit link the chat UI shows for an action: the server-computed `href`
 * when present, else (an action from before `href` existed) the page editor
 * for page actions only. Other actions — including deleted items — get none.
 */
export function chatActionEditLink(
  action: { type: string; target?: string; href?: string; link_label?: string },
  siteId: string,
): ChatEditLink | null {
  // Only portal-relative editor paths; never an arbitrary URL.
  if (action.href) return action.href.startsWith('/app/') ? { href: action.href, link_label: action.link_label || 'Edit' } : null;
  if (action.target && PAGE_ACTION_TYPES.has(action.type)) return chatEditLink(siteId, 'page', action.target);
  return null;
}
