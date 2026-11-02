// Site header behaviour while the visitor scrolls (site setting `header_behavior`).
//
//   static               the header scrolls away with the page (default; writes nothing)
//   sticky               the header stays at the top
//   reveal_on_scroll_up  the header hides while scrolling down and returns as a
//                        compact header as soon as the visitor scrolls up; in the
//                        compact state the navigation menu opens from its toggle
//                        at every width, not only below its collapse width
//
// Pages of a site without the setting are unchanged: no attribute, CSS or script.

export const HEADER_BEHAVIORS = ['static', 'sticky', 'reveal_on_scroll_up'] as const;
export type HeaderBehavior = (typeof HEADER_BEHAVIORS)[number];

export function isHeaderBehavior(value: unknown): value is HeaderBehavior {
  return typeof value === 'string' && (HEADER_BEHAVIORS as readonly string[]).includes(value);
}

/** The behaviour to render, or null when the page needs nothing (static or unset). */
export function activeHeaderBehavior(value: unknown): Exclude<HeaderBehavior, 'static'> | null {
  return value === 'sticky' || value === 'reveal_on_scroll_up' ? value : null;
}

/** Adds `data-header-behavior` to the site header's opening tag. */
export function withHeaderBehaviorAttribute(headerHtml: string, behavior: unknown): string {
  const active = activeHeaderBehavior(behavior);
  if (!active) return headerHtml;
  return headerHtml.replace(/<header(?=[\s>])/i, `<header data-header-behavior="${active}"`);
}

export const HEADER_BEHAVIOR_CSS = `
header[data-header-behavior] { position:sticky; top:0; z-index:200; }
header[data-header-behavior="reveal_on_scroll_up"] { transition:transform .25s ease; }
header[data-header-behavior="reveal_on_scroll_up"][data-header-hidden] { transform:translateY(-100%); }
header[data-header-behavior="reveal_on_scroll_up"][data-header-compact] [data-block="navigation_menu"][data-enhanced="true"] > .block-menu-open { display:inline-flex; align-items:center; justify-content:center; }
header[data-header-behavior="reveal_on_scroll_up"][data-header-compact] [data-block="navigation_menu"][data-enhanced="true"] > :is(.block-menu-content,.block-menu-mobile) { display:none; }
@media (prefers-reduced-motion:reduce) { header[data-header-behavior="reveal_on_scroll_up"] { transition:none; } }
`.trim();

/**
 * Hides the header while scrolling down and shows it again on the first scroll
 * up. Once the page has scrolled past the header, the shown header is compact
 * (`data-header-compact`): sites can style that state, and the navigation menu
 * opens from its toggle at every width. Keyboard focus inside the header and an
 * open menu always keep it visible.
 */
export const HEADER_BEHAVIOR_RUNTIME_JS = String.raw`(function(){
  var header = document.querySelector('header[data-header-behavior="reveal_on_scroll_up"]');
  if (!header) return;
  var last = window.scrollY, scheduled = false, threshold = 6;
  function menuOpen() { return !!header.querySelector('dialog[open]'); }
  function update() {
    scheduled = false;
    var y = Math.max(0, window.scrollY), height = header.offsetHeight;
    var compact = y > height;
    if (compact) header.setAttribute('data-header-compact', ''); else header.removeAttribute('data-header-compact');
    if (y <= height || menuOpen() || header.contains(document.activeElement)) header.removeAttribute('data-header-hidden');
    else if (y > last + threshold) header.setAttribute('data-header-hidden', '');
    else if (y < last - threshold) header.removeAttribute('data-header-hidden');
    if (Math.abs(y - last) > threshold) last = y;
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', schedule, { passive: true });
  header.addEventListener('focusin', function () { header.removeAttribute('data-header-hidden'); });
  update();
})();`;
