// Response headers for preview surfaces that render customer content on the
// PORTAL's origin.
//
// The threat: `render-preview.ts` serves customer HTML from app.typeroll.com,
// the same origin that holds the portal session cookie. Anything that manages
// to execute there runs with the viewer's portal authority — and the viewer
// may be someone the content's author has no business acting as: a user of an
// org the site was merely SHARED INTO, or a platform operator whose session
// reaches /api/internal-admin/* across every tenant.
//
// Today the sanitizer strips <script> before it ever reaches a browser, so
// this is defense in depth rather than the only lock. That's the point: every
// sanitizer eventually has a bypass, and a bypass on this origin is a session
// compromise rather than a defaced preview.
//
// `sandbox` WITHOUT `allow-same-origin` forces the document into an opaque
// origin. Scripts still run — the preview stays faithful — but they cannot
// read the portal's cookies, storage, or DOM. Sending it as a RESPONSE HEADER
// rather than an iframe attribute is deliberate: the attribute only protects
// the embedded case, while the header also covers a preview URL opened
// directly in a tab, which is exactly what a phishing link would do.
//
// Editor interaction also runs in this sandbox. Its block selection, inline
// editing, geometry and scroll synchronization use a versioned postMessage
// bridge; the parent never reaches into `iframe.contentDocument`.

/**
 * Sandbox directive for isolated preview responses.
 *
 * `allow-same-origin` must never appear here — with it, the sandbox grants
 * back exactly the access this header exists to remove, and the whole
 * mitigation silently becomes a no-op.
 */
export const PREVIEW_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';

/**
 * Headers for a preview response that renders customer HTML and does NOT need
 * same-origin access from the embedding page. Spread into a Response's
 * headers alongside Content-Type.
 */
export function isolatedPreviewHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': PREVIEW_SANDBOX,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

/**
 * Legacy CSP kept for non-interactive consumers during migration. The main
 * editor canvas now uses PREVIEW_SANDBOX and the postMessage bridge.
 *
 * Same-origin means anything that executes in the canvas runs with the
 * viewer's portal session. The canvas already refuses to render block JS
 * (`allowScripts: false`), so the sanitizer was the only thing standing
 * between a bypass and a session compromise. This removes that single point
 * of failure: `script-src 'none'` stops ALL script execution in the document
 * — injected `<script>`, inline event handlers, and `javascript:` URLs alike
 * — while leaving the parent's DOM access untouched, because CSP governs the
 * document it's delivered with, not the parent reaching into it.
 *
 * Verified in a browser: with this header a parent can still read
 * contentDocument, set `contenteditable`, call `elementFromPoint` and read
 * `scrollY`, while both a `<script>` block and an `onerror` handler inside
 * the frame fail to run.
 *
 * `object-src 'none'` closes the plugin equivalent. Styles stay permissive:
 * the preview is meant to look like the real site, and CSS can't reach
 * cookies or call APIs.
 *
 * This is NOT a replacement for the postMessage migration (see
 * docs/directory-app-plan.md §7c) — that remains the way to run block JS in
 * the canvas at all. It's the cheap part of that work's value, available now.
 */
export const EDITOR_CANVAS_CSP = "script-src 'none'; object-src 'none'";

/**
 * Headers for the editor canvas: same-origin (so the editor keeps working)
 * but with script execution disabled.
 */
export function editorCanvasHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': EDITOR_CANVAS_CSP,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    // Iframes inside the portal need to be allowed from same-origin.
    'X-Frame-Options': 'SAMEORIGIN',
  };
}
