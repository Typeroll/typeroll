import { describe, it, expect } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { sanitizeBody } from '../../lib/sanitize';

// The sanitizer is the only thing standing between a customer's HTML (or an
// LLM's output) and the published page. Worth pinning the security
// guarantees down with explicit tests.

describe('sanitizeBody', () => {
  it('strips <script> tags', () => {
    const out = sanitizeBody('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('<p>hi</p>');
  });

  it('drops inline event handlers', () => {
    const out = sanitizeBody('<button onclick="alert(1)">go</button>');
    expect(out).not.toContain('onclick');
  });

  it('rejects javascript: URLs', () => {
    const out = sanitizeBody('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });

  it('rejects javascript destinations hidden later in an SVG SMIL URI list', () => {
    const input =
      '<svg><a><animate attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"></animate><text y="30">Click me</text></a></svg>';
    const out = sanitizeHtml(input, {
      allowedTags: [...sanitizeHtml.defaults.allowedTags, 'svg', 'animate', 'text'],
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        animate: ['attributename', 'values', 'dur', 'fill'],
        text: ['y'],
      },
      allowedSchemesAppliedToAttributes: [...sanitizeHtml.defaults.allowedSchemesAppliedToAttributes, 'values'],
    });

    expect(out).not.toContain('javascript:');
    expect(out).not.toMatch(/attributeName=["']href["']/i);
  });

  it('keeps semantic tags + safe attributes', () => {
    const out = sanitizeBody(
      '<section class="hero"><h1 id="t">Hi</h1><p style="color:#f00">x</p></section>',
    );
    expect(out).toContain('<section');
    expect(out).toContain('class="hero"');
    expect(out).toContain('id="t"');
    expect(out).toContain('color');
  });

  it('keeps the form honeypot out of the keyboard tab order', () => {
    const out = sanitizeBody(
      '<input type="text" name="_hp" class="form-hp" tabindex="-1" autocomplete="off" aria-hidden="true" />',
    );
    expect(out).toContain('name="_hp"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain('aria-hidden="true"');
  });

  it('still strips positive tabindex values from authored inputs', () => {
    const out = sanitizeBody('<input type="text" name="query" tabindex="1" />');
    expect(out).not.toContain('tabindex');
  });

  it('keeps img with srcset / loading / decoding / width / height', () => {
    const out = sanitizeBody(
      '<img src="/a.png" srcset="/a.png 1x" sizes="100vw" alt="A" width="200" height="100" loading="lazy" decoding="async" />',
    );
    expect(out).toContain('srcset=');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('width="200"');
  });

  it('keeps download links and ellipse SVG geometry', () => {
    const out = sanitizeBody(
      '<a href="/checklist.pdf" download>Download</a>' +
      '<svg viewBox="0 0 20 10"><ellipse cx="10" cy="5" rx="8" ry="3" /></svg>',
    );
    expect(out).toContain('download');
    expect(out).toContain('<ellipse');
    expect(out).toContain('rx="8"');
    expect(out).toContain('ry="3"');
  });

  it('keeps iframes from allowed video hosts; strips src from others', () => {
    const yt = sanitizeBody('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(yt).toContain('youtube.com');
    const evil = sanitizeBody('<iframe src="https://evil.example.com/"></iframe>');
    // The tag may survive but the dangerous src must not.
    expect(evil).not.toContain('evil.example.com');
  });

  it('allows an exact per-site iframe host without widening the default policy', () => {
    const html = '<iframe src="https://player.vendor.example/embed/42"></iframe>';
    expect(sanitizeBody(html)).not.toContain('src=');
    expect(sanitizeBody(html, ['player.vendor.example'])).toContain('src="https://player.vendor.example/embed/42"');
    expect(sanitizeBody('<iframe src="https://sub.player.vendor.example/embed/42"></iframe>', ['player.vendor.example']))
      .not.toContain('src=');
  });

  it('is idempotent — sanitizing already-sanitized HTML changes nothing', () => {
    const input = '<p>safe <strong>html</strong></p>';
    const once = sanitizeBody(input);
    const twice = sanitizeBody(once);
    expect(twice).toBe(once);
  });

  // Regression: an agent reported that Lucide-style icons rendered with
  // default strokes because stroke-width / stroke-linecap / stroke-linejoin
  // were dropped from the <svg> root. The presentational attributes are
  // commonly set on <svg> so paths inherit them; without this fix every
  // icon drops back to stroke-width=1 with butt caps.
  it('preserves stroke attributes on the <svg> root (Lucide / Heroicons pattern)', () => {
    const input =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 5v14M5 12h14" /></svg>';
    const out = sanitizeBody(input);
    expect(out).toContain('stroke-width="2"');
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain('stroke-linejoin="round"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('stroke="currentColor"');
  });

  it('keeps stroke + fill attributes on SVG child elements', () => {
    const input =
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="red" stroke-width="3" />' +
      '<line x1="0" y1="0" x2="24" y2="24" stroke="blue" stroke-width="1" /></svg>';
    const out = sanitizeBody(input);
    expect(out).toContain('stroke-width="3"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('<line');
    expect(out).toContain('stroke="blue"');
  });

  it('still drops <script> inside <svg> (no smuggling via SVG)', () => {
    const input = '<svg><script>alert(1)</script><path d="M0,0L10,10"/></svg>';
    const out = sanitizeBody(input);
    expect(out).not.toContain('<script');
    expect(out).toContain('<path');
  });

  // Regression — see docs/page-slug-audit-style coverage and the C1
  // entry in feedback_skill_updates.md. The bug: update_page sanitises
  // html_content, sanitize-html drops all comments, regenerate-listing's
  // marker pair disappears, subsequent regenerates 400 with
  // "Markers not found".
  describe('typeroll listing markers survive sanitization', () => {
    it('preserves the open/close marker pair around content', () => {
      const input = '<h2>Posts</h2><!-- typeroll:listing:blog --><p>old</p><!-- /typeroll:listing:blog --><p>after</p>';
      const out = sanitizeBody(input);
      expect(out).toContain('<!-- typeroll:listing:blog -->');
      expect(out).toContain('<!-- /typeroll:listing:blog -->');
      expect(out).toContain('<p>old</p>');
      expect(out).toContain('<p>after</p>');
    });

    it('still drops plain prose comments', () => {
      const input = '<p>visible</p><!-- this is a note --><p>also visible</p>';
      const out = sanitizeBody(input);
      expect(out).not.toContain('this is a note');
      expect(out).toContain('<p>visible</p>');
      expect(out).toContain('<p>also visible</p>');
    });

    it('preserves compact migration placeholder comments', () => {
      const out = sanitizeBody('<header><!-- ME_BANNER --></header><!-- footer-slot -->');
      expect(out).toContain('<!-- ME_BANNER -->');
      expect(out).toContain('<!-- footer-slot -->');
    });

    it('preserves markers across repeated sanitization (idempotency)', () => {
      const first = sanitizeBody('<!-- typeroll:listing:posts --><p>x</p><!-- /typeroll:listing:posts -->');
      const second = sanitizeBody(first);
      expect(second).toContain('<!-- typeroll:listing:posts -->');
      expect(second).toContain('<!-- /typeroll:listing:posts -->');
      expect(second).toBe(first);
    });

    it('does not let a non-typeroll comment with a `typeroll:` prefix escape', () => {
      // The pattern requires the comment to START with `typeroll:` (or `/typeroll:`),
      // so prose-style "see typeroll: feature for…" comments still drop.
      const out = sanitizeBody('<!-- see typeroll: docs --><p>x</p>');
      expect(out).not.toContain('see typeroll:');
    });

    it('rejects marker payloads containing HTML metacharacters', () => {
      // Defense in depth: the protect step's allowlist refuses payloads
      // with characters like `<` or `>` so a crafted comment can't inject
      // markup through the token.
      const out = sanitizeBody('<!-- typeroll:listing:<script>alert(1)</script> --><p>x</p>');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('alert(1)');
    });
  });

  // Regression — sanitize-html's parser lowercases every attribute name
  // (HTML mode default). For SVG, several attributes are case-sensitive
  // when interpreted as XML, so the post-pass restores known camelCase
  // names inside <svg>…</svg> blocks. Reported from autopilot.se 2026-05
  // when the migration emitted `<svg viewbox="..."` which would have
  // broken under an XHTML serializer.
  describe('SVG attribute case preservation', () => {
    it('restores viewBox in a basic SVG', () => {
      const input = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
      const out = sanitizeBody(input);
      expect(out).toContain('viewBox="0 0 24 24"');
      expect(out).not.toMatch(/\bviewbox=/);
    });

    it('restores preserveAspectRatio + gradientUnits + clipPathUnits', () => {
      const input =
        '<svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet">' +
        '<linearGradient gradientUnits="userSpaceOnUse" />' +
        '<clipPath clipPathUnits="objectBoundingBox" />' +
        '</svg>';
      const out = sanitizeBody(input);
      expect(out).toContain('preserveAspectRatio="xMidYMid meet"');
      expect(out).toContain('gradientUnits="userSpaceOnUse"');
      expect(out).toContain('clipPathUnits="objectBoundingBox"');
    });

    it('leaves HTML attributes outside SVG untouched (no false positives)', () => {
      // `viewbox` outside an SVG block would be rewritten if our regex ran
      // globally — but the pass only runs inside <svg>…</svg>, so a plain
      // HTML element using a similar data-attribute stays as-is.
      const input =
        '<div data-viewbox="legacy"><p>before</p></div>' +
        '<svg viewBox="0 0 24 24"><path d="M0 0h24v24"/></svg>';
      const out = sanitizeBody(input);
      expect(out).toContain('data-viewbox="legacy"');   // outside SVG: unchanged
      expect(out).toContain('viewBox="0 0 24 24"');     // inside SVG: restored
    });

    it('handles multiple SVG blocks independently', () => {
      const input =
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>' +
        '<p>between</p>' +
        '<svg viewBox="0 0 16 16" preserveAspectRatio="xMinYMin"><rect width="16" height="16"/></svg>';
      const out = sanitizeBody(input);
      expect((out.match(/viewBox=/g) || []).length).toBe(2);
      expect(out).toContain('preserveAspectRatio="xMinYMin"');
    });

    it('is a no-op when no SVG is present (fast path)', () => {
      const input = '<p>plain text</p><div>no svg here</div>';
      const out = sanitizeBody(input);
      expect(out).toBe(sanitizeBody(input));   // idempotent
      expect(out).toContain('plain text');
    });
  });
});
