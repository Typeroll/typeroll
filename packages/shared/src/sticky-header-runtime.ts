/**
 * Reserves the space a sticky or fixed site header covers, so everything that
 * scrolls an element into view lands below it: fragment links and `:target`,
 * `scrollIntoView()` from blocks and Extensions, and `focus()` on a form
 * field. It sets `html { scroll-padding-top }` to the header's bottom edge
 * plus a small gap, re-measured when the header resizes or the viewport
 * changes breakpoint.
 *
 * Pages without a top-sticky or fixed header are left untouched, and so is a
 * site that sets its own `scroll-padding-top`. The reserved value is published
 * on `html[data-tr-header-clearance]` so the outline block does not add the
 * same clearance again as its own scroll margin.
 *
 * Runs on the published site and in the preview shell, before the block
 * scripts, so their first measurement already sees the reservation.
 */
export const STICKY_HEADER_GAP_PX = 16;

export const STICKY_HEADER_RUNTIME_JS = String.raw`(function(){
  var root = document.documentElement;
  var own = getComputedStyle(root).scrollPaddingTop;
  if (own && own !== 'auto' && parseFloat(own) > 0) return;
  var selector = 'header, .site-header, [data-site-header], [data-block="container"][data-sticky="true"], [data-block="semantic-container"][data-sticky="true"]';
  var headers = Array.prototype.filter.call(document.querySelectorAll(selector), function (node) { return !node.closest('main'); });
  if (!headers.length) return;
  var previous = null, scheduled = false;
  function clearance() {
    return headers.reduce(function (bottom, header) {
      var style = getComputedStyle(header);
      var top = parseFloat(style.top);
      if ((style.position !== 'sticky' && style.position !== 'fixed') || !isFinite(top) || style.display === 'none') return bottom;
      var rect = header.getBoundingClientRect();
      if (!rect.height) return bottom;
      return Math.max(bottom, style.position === 'sticky' ? Math.max(0, top + rect.height) : Math.max(0, rect.bottom));
    }, 0);
  }
  function update() {
    scheduled = false;
    var covered = Math.ceil(clearance());
    var reserved = covered > 0 ? covered + ${STICKY_HEADER_GAP_PX} : 0;
    if (reserved === previous) return;
    previous = reserved;
    if (reserved) { root.style.scrollPaddingTop = reserved + 'px'; root.setAttribute('data-tr-header-clearance', String(reserved)); }
    else { root.style.removeProperty('scroll-padding-top'); root.removeAttribute('data-tr-header-clearance'); }
    window.dispatchEvent(new CustomEvent('typeroll:header-clearance', { detail: { px: reserved } }));
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  if (typeof ResizeObserver === 'function') {
    var observer = new ResizeObserver(schedule);
    headers.forEach(function (header) { observer.observe(header); });
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
  update();
})();`;
