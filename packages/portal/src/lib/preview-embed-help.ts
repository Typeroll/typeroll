/** Preview-only help. An iframe load event is not proof that its contents loaded. */
export function previewEmbedHelpScript(): string {
  return `(${installPreviewEmbedHelp.toString()})();`;
}

function installPreviewEmbedHelp() {
  const seen = new WeakSet<HTMLIFrameElement>();
  function inspect(frame: HTMLIFrameElement) {
    if (seen.has(frame) || frame.hidden || frame.closest('[hidden]') || frame.hasAttribute('srcdoc')) return;
    let target: URL;
    try { target = new URL(frame.getAttribute('src') || '', location.href); } catch { return; }
    if (!['http:', 'https:'].includes(target.protocol) || target.origin === location.origin || !frame.getAttribute('src')) return;
    // Consent placeholders with no src stay untouched. Never fetch or retry automatically.
    const style = getComputedStyle(frame);
    if (style.display === 'none' || style.visibility === 'hidden' || frame.getBoundingClientRect().width < 20) return;
    seen.add(frame);
    const host = document.createElement('div');
    host.setAttribute('data-preview-embed-help', '1');
    const shadow = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = ':host{display:block;clear:both;margin:.5rem 0;font:14px/1.5 system-ui;color:#292936}details{padding:.5rem .75rem;border:1px solid #c8c8d0;border-radius:6px;background:#f7f7fa}summary{cursor:pointer}p{margin:.5rem 0}a,button{color:#67307b}button{margin-left:1rem;font:inherit;background:white;border:1px solid #777;border-radius:4px;padding:.2rem .5rem}';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'External embed · ' + target.hostname;
    const description = document.createElement('p');
    description.textContent = 'If this embed is blank, its provider may restrict previews, require consent or need a published domain. Typeroll cannot confirm whether it loaded. Check the published page separately before launch.';
    const link = document.createElement('a');
    link.href = target.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open provider separately';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = 'Reload embed';
    retry.addEventListener('click', () => { if (confirm('Reload this embed? Any unsent form answers may be lost.')) frame.src = frame.src; });
    details.append(summary, description, link, retry); shadow.append(css, details);
    frame.insertAdjacentElement('afterend', host);
    let wasCollapsed = false;
    const resize = new ResizeObserver(() => {
      const collapsed = frame.getBoundingClientRect().height < 20;
      if (collapsed !== wasCollapsed) {
        details.open = collapsed;
        summary.textContent = (collapsed ? 'No visible embed · ' : 'External embed · ') + target.hostname;
        wasCollapsed = collapsed;
      }
    });
    resize.observe(frame);
  }
  const scan = () => document.querySelectorAll<HTMLIFrameElement>('iframe').forEach(inspect);
  requestAnimationFrame(scan);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}
