import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks } from '@typeroll/shared';
import { sanitizeBody as portal } from '../../lib/sanitize';
import { sanitizeBody as renderer } from '../../../../site-template/src/lib/sanitize';

// A consent-gated core/embed keeps its html in <template data-tr-consent="optional">.
// The rendered body passes the sanitizer, which must keep that template (or
// the iframe would load before consent) while still sanitizing its content.
const registry = buildCoreBlockRegistry();
const gated = (html: string) => renderBlocks([{ id: 'cmp', type: 'core/embed', data: { html, consent: 'optional' } }], { registry });

describe.each([['portal', portal], ['renderer', renderer]] as const)('%s sanitizer and consent-gated embeds', (_name, sanitize) => {
  it('keeps the gated embed byte for byte', () => {
    const html = gated('<iframe src="https://www.youtube-nocookie.com/embed/x" title="Video"></iframe>');
    expect(sanitize(html)).toBe(html);
  });

  it('sanitizes the gated content like any other markup', () => {
    const out = sanitize('<template data-tr-consent="optional"><p onclick="x()">Hi</p><script>steal()</script><iframe src="https://evil.example/"></iframe></template>');
    // The disallowed host loses its src, exactly as outside the gate.
    expect(out).toBe('<template data-tr-consent="optional"><p>Hi</p><iframe></iframe></template>');
  });

  it('keeps an iframe host allowed by the site inside the gate', () => {
    const out = sanitize(gated('<iframe src="https://tool.vendor.example/compare"></iframe>'), ['tool.vendor.example']);
    expect(out).toContain('<template data-tr-consent="optional"><iframe src="https://tool.vendor.example/compare"></iframe></template>');
  });

  it('still unwraps any other template, as before', () => {
    expect(sanitize('<template><p>Shown</p></template>')).toBe('<p>Shown</p>');
    expect(sanitize('<template data-tr-consent="necessary"><p>Shown</p></template>')).toBe('<p>Shown</p>');
  });

  it('keeps the placeholder button that opens the banner', () => {
    expect(sanitize(gated('<p>x</p>'))).toContain('<button type="button" class="tr-consent-embed__button" data-tr-open-consent>');
  });
});
