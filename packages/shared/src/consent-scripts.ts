// Consent gating for SiteSettings.cookie_consent.scripts_optional.
//
// The field holds vendor snippets pasted verbatim (gtag.js, Meta Pixel,
// Hotjar, …) — almost always a mix of <script> tags and a <noscript>
// fallback. Wrapping the WHOLE field in one <script type="text/plain">
// does not survive that input: the browser closes the wrapper at the
// first </script> inside the content, so everything after it executes
// immediately — before consent — while the half left inside the broken
// wrapper never runs at all.
//
// Instead, wrapConsentScripts() tokenises the field and emits:
//   - each <script> individually as type="text/plain"
//     data-tr-consent="optional", original attributes preserved. A
//     script whose type isn't a JavaScript MIME type is never fetched
//     nor executed, so `src` can stay as-is.
//   - everything between scripts (noscript fallbacks, HTML comments,
//     tracking pixels) inside <template data-tr-consent="optional"> —
//     template content is inert (no image fetches, no execution) until
//     the runtime stamps it out after consent.
//
// buildConsentRuntime() is the inline browser script CookieConsent.astro
// ships; its activate() mirrors the wrapper: scripts are recreated as
// real script elements (inline body via .text, external via the copied
// src attribute), templates are replaced by their content. Both halves
// live in this file so they can't drift apart, and so they're unit-
// testable outside Astro.

// Matches one <script …>…</script> element. Attribute values containing
// a literal ">" would break the attr group — vendor snippets don't do
// that, and the failure mode is an inert (over-wrapped) script, not a
// consent leak.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Strip any author-written type attribute so the inert text/plain type
 *  we set can't be overridden back to an executable one. */
function stripTypeAttr(attrs: string): string {
  return attrs.replace(/\s*\btype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function wrapScript(attrs: string, body: string): string {
  const rest = stripTypeAttr(attrs).trim();
  const restAttr = rest ? ` ${rest}` : '';
  return `<script type="text/plain" data-tr-consent="optional"${restAttr}>${body}</script>`;
}

function wrapOther(chunk: string): string {
  // Whitespace between tags passes through untouched; anything with
  // substance (noscript, comments, pixels) goes inert into a template.
  if (!chunk.trim()) return chunk;
  return `<template data-tr-consent="optional">${chunk}</template>`;
}

/**
 * Convert the raw scripts_optional field into consent-gated, inert HTML.
 *
 * Back-compat: a value with no <script> tag at all is treated as bare
 * JavaScript (the only format the pre-fix wrapper actually supported)
 * and wrapped as a single inline script.
 */
export function wrapConsentScripts(input: string): string {
  const value = input ?? '';
  if (!value.trim()) return '';
  if (!/<script\b/i.test(value)) {
    return wrapScript('', value);
  }

  let out = '';
  let last = 0;
  SCRIPT_RE.lastIndex = 0;
  for (let m = SCRIPT_RE.exec(value); m; m = SCRIPT_RE.exec(value)) {
    out += wrapOther(value.slice(last, m.index));
    out += wrapScript(m[1], m[2]);
    last = m.index + m[0].length;
  }
  out += wrapOther(value.slice(last));
  return out;
}

/**
 * The inline consent runtime (cookie read/write, modal wiring, script
 * activation). Returned as a string for `<script is:inline set:html>`.
 * Must never contain a literal "</script" — it's injected inside a
 * script element.
 */
export function buildConsentRuntime(reloadAfterConsent: boolean): string {
  return `(function(){
      var COOKIE='tr_consent',DAYS=365,RELOAD=${reloadAfterConsent ? 'true' : 'false'};
      function read(){var m=document.cookie.match(/(?:^|;\\s*)tr_consent=([^;]+)/);return m?decodeURIComponent(m[1]):null}
      function write(v){var d=new Date();d.setTime(d.getTime()+DAYS*864e5);var sec=location.protocol==='https:'?'; Secure':'';document.cookie=COOKIE+'='+encodeURIComponent(v)+'; expires='+d.toUTCString()+'; path=/; SameSite=Lax'+sec}
      function activate(){var ns=document.querySelectorAll('script[type="text/plain"][data-tr-consent="optional"],template[data-tr-consent="optional"]');for(var i=0;i<ns.length;i++){var n=ns[i];if(n.tagName==='TEMPLATE'){n.parentNode.replaceChild(n.content.cloneNode(true),n);continue}var s=document.createElement('script');for(var j=0;j<n.attributes.length;j++){var a=n.attributes[j];if(a.name==='type'||a.name==='data-tr-consent')continue;s.setAttribute(a.name,a.value)}s.text=n.textContent||'';n.parentNode.replaceChild(s,n)}}
      function set(choice){write(choice);document.documentElement.classList.remove('tr-consent-needed');document.dispatchEvent(new CustomEvent('typeroll:consent',{detail:{choice:choice}}));if(RELOAD){location.reload();return}if(choice==='all')activate()}
      var cur=read();
      if(cur==='all'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',activate);else activate()}
      function open(){document.documentElement.classList.add('tr-consent-needed')}
      function attach(){var r=document.getElementById('tr-consent');if(r){r.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-tr-consent-action]');if(!b)return;var a=b.getAttribute('data-tr-consent-action');if(a==='all'||a==='necessary'||a==='rejected')set(a)})}
        /* Delegate clicks on any element carrying data-tr-open-consent —
           footer links, the floating chip, custom block "Manage cookies"
           buttons, etc. One handler on document, no per-link wiring. */
        document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-tr-open-consent]');if(!t)return;e.preventDefault();open()})}
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
      window.typerollConsent={open:open,close:function(){document.documentElement.classList.remove('tr-consent-needed')},set:set,get:read};
    })();`;
}
