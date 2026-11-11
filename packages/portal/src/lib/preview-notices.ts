// Notices about a navigable preview (content changed since the link was made,
// app data that could not be derived) without touching the page's layout.
//
// The frame response is what rendering QA, screenshots and visual comparison
// capture, so a notice must never be part of its document flow: it would push
// the page down whenever anyone edits any page. The frame therefore carries
// the state only in non-visual form (a response header and a <meta> element)
// and hands the notices to the trusted shell over the preview bridge, which
// shows them as a fixed overlay outside the frame.

export type PreviewNoticeKind = 'derivation-failed' | 'content-changed';

export interface PreviewNotice {
  kind: PreviewNoticeKind;
  message: string;
}

/** Response header naming the preview's notice kinds, comma-separated. */
export const PREVIEW_STATE_HEADER = 'X-Typeroll-Preview-State';

/** Response headers for a frame response with these notices. */
export function previewStateHeaders(notices: readonly PreviewNotice[]): Record<string, string> {
  return notices.length ? { [PREVIEW_STATE_HEADER]: notices.map((notice) => notice.kind).join(', ') } : {};
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Add the notices to a frame document without rendering anything: one
 * `<meta name="typeroll-preview-state">` with the kinds, one
 * `<meta name="typeroll-preview-notice">` per notice, and, inside a shell, a
 * script that posts them to it. The script always runs when a bridge is
 * given, so the shell also clears notices of the previous page.
 */
export function injectPreviewNotices(
  html: string,
  notices: readonly PreviewNotice[],
  bridge?: { id: string; parentOrigin: string },
): string {
  const meta = notices.length
    ? `<meta name="typeroll-preview-state" content="${escapeAttribute(notices.map((notice) => notice.kind).join(' '))}">`
      + notices.map((notice) => `<meta name="typeroll-preview-notice" data-kind="${notice.kind}" content="${escapeAttribute(notice.message)}">`).join('')
    : '';
  const payload = JSON.stringify({
    channel: 'typeroll.extension-preview',
    version: 1,
    bridge_id: bridge?.id ?? '',
    action: 'preview.notices',
    notices,
  }).replace(/</g, '\\u003c');
  const script = bridge
    ? `<script>(function(){try{if(parent!==window)parent.postMessage(${payload},${JSON.stringify(bridge.parentOrigin).replace(/</g, '\\u003c')});}catch(_){}})();</script>`
    : '';
  const head = meta + script;
  if (!head) return html;
  // At the end of <head>: the charset declaration stays within the first
  // bytes, and nothing lands before the doctype (which would mean quirks mode).
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, (match) => head + match);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => match + head);
  return html + head;
}
