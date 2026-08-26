import { describe, it, expect } from 'vitest';
import { wrapConsentScripts, buildConsentRuntime } from '../consent-scripts';

// Regression guard for the consent-gating leak: the old implementation
// wrapped the WHOLE scripts_optional field in one
// <script type="text/plain"> — a pasted vendor snippet containing its
// own </script> split that wrapper open and everything after the split
// executed BEFORE consent (verified live: Meta Pixel PageView fired with
// the banner still up, while gtag.js never loaded at all).

// Verbatim how Google + Meta distribute their snippets — multiple
// script tags, an inline config body, and a noscript img fallback.
const VENDOR_SNIPPET = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-TEST123');
</script>
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};t=b.createElement(e);
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1234567890');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=1234567890&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`;

/** Every <script> open tag in the output, with its attribute string. */
function scriptOpenTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? [];
}

/** Remove all gated constructs; whatever is left would run/load before consent. */
function ungatedResidue(html: string): string {
  return html
    .replace(/<script type="text\/plain" data-tr-consent="optional"[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<template data-tr-consent="optional">[\s\S]*?<\/template>/g, '');
}

describe('wrapConsentScripts', () => {
  it('gates every script in a multi-script vendor snippet individually', () => {
    const out = wrapConsentScripts(VENDOR_SNIPPET);

    const tags = scriptOpenTags(out);
    expect(tags).toHaveLength(3); // gtag loader + gtag config + pixel
    for (const tag of tags) {
      expect(tag).toContain('type="text/plain"');
      expect(tag).toContain('data-tr-consent="optional"');
    }

    // Inline bodies survive intact inside their own wrappers.
    expect(out).toContain("gtag('config', 'G-TEST123');");
    expect(out).toContain("fbq('track', 'PageView');");
  });

  it('leaves nothing executable or loadable outside the gated wrappers', () => {
    const residue = ungatedResidue(wrapConsentScripts(VENDOR_SNIPPET));
    expect(residue).not.toMatch(/<script/i);
    expect(residue).not.toMatch(/<img/i);
    expect(residue).not.toMatch(/<noscript/i);
    expect(residue).not.toContain('fbq(');
    expect(residue.trim()).toBe('');
  });

  it('preserves src and async on external scripts (inert via type, not removal)', () => {
    const out = wrapConsentScripts(VENDOR_SNIPPET);
    const loader = scriptOpenTags(out).find((t) => t.includes('googletagmanager'));
    expect(loader).toBeDefined();
    expect(loader).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"');
    expect(loader).toContain('async');
  });

  it('parks noscript fallbacks (tracking pixels) in an inert template', () => {
    const out = wrapConsentScripts(VENDOR_SNIPPET);
    expect(out).toMatch(
      /<template data-tr-consent="optional">[\s\S]*facebook\.com\/tr[\s\S]*?<\/template>/,
    );
    // The pixel <img> must not appear outside a template.
    expect(ungatedResidue(out)).not.toContain('facebook.com/tr');
  });

  it('replaces an author-written type attribute instead of duplicating it', () => {
    const out = wrapConsentScripts(
      `<script type="text/javascript" id="hj">console.log(1)</script>`,
    );
    const [tag] = scriptOpenTags(out);
    expect(tag).toBe('<script type="text/plain" data-tr-consent="optional" id="hj">');
    expect(tag).not.toContain('text/javascript');
  });

  it('back-compat: bare JavaScript (no tags) wraps as a single inline script', () => {
    const out = wrapConsentScripts(`console.log('plain js');`);
    expect(out).toBe(
      `<script type="text/plain" data-tr-consent="optional">console.log('plain js');</script>`,
    );
  });

  it('returns empty output for empty or whitespace-only input', () => {
    expect(wrapConsentScripts('')).toBe('');
    expect(wrapConsentScripts('   \n  ')).toBe('');
  });
});

describe('buildConsentRuntime', () => {
  it('inlines the reload flag', () => {
    expect(buildConsentRuntime(true)).toContain('RELOAD=true');
    expect(buildConsentRuntime(false)).toContain('RELOAD=false');
  });

  it('never contains a literal </script (it is injected inside a script element)', () => {
    expect(buildConsentRuntime(false)).not.toMatch(/<\/script/i);
    expect(buildConsentRuntime(true)).not.toMatch(/<\/script/i);
  });
});
