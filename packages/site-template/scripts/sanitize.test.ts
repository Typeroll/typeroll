import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeBody } from '../src/lib/sanitize.ts';

test('keeps the form honeypot out of the keyboard tab order', () => {
  const out = sanitizeBody(
    '<input type="text" name="_hp" class="form-hp" tabindex="-1" autocomplete="off" aria-hidden="true" />',
  );

  assert.match(out, /name="_hp"/);
  assert.match(out, /tabindex="-1"/);
  assert.match(out, /aria-hidden="true"/);
});

test('strips positive tabindex values from authored inputs', () => {
  const out = sanitizeBody('<input type="text" name="query" tabindex="1" />');

  assert.doesNotMatch(out, /tabindex/);
});

test('allows only an exact configured iframe host', () => {
  const configured = sanitizeBody(
    '<iframe src="https://player.vendor.example/embed/42"></iframe>',
    ['player.vendor.example'],
  );
  const subdomain = sanitizeBody(
    '<iframe src="https://sub.player.vendor.example/embed/42"></iframe>',
    ['player.vendor.example'],
  );

  assert.match(configured, /src="https:\/\/player\.vendor\.example\/embed\/42"/);
  assert.doesNotMatch(subdomain, /src=/);
});

test('keeps render version 2 heading groups, style classes and global block markers', () => {
  const html = '<div data-block="heading" data-level="h2"><hgroup class="block-heading-group"><p class="block-heading-eyebrow s-eyebrow">For leaders</p><h2 class="block-heading-text hero-title">Plan</h2><p class="block-heading-subtitle tr-role-lead">In a day</p></hgroup></div><section data-block="section" data-global-block="call-to-action">Shared</section>';
  assert.equal(sanitizeBody(html), html);
});

function encodeMarkup(html: string, folds: number): string {
  let out = html;
  for (let i = 0; i < folds; i++) out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return out;
}

test('never turns entity-encoded <svg><style> text into markup (1-3 encoding levels)', () => {
  for (const folds of [1, 2, 3]) {
    for (const wrap of [
      (inner: string) => `<svg><style>${inner}</style></svg>`,
      (inner: string) => `<math><style>${inner}</style></math>`,
      (inner: string) => `<svg><foreignObject><style>${inner}</style></foreignObject></svg>`,
    ]) {
      let out = wrap(encodeMarkup('</style><img src=x onerror=alert(1)>', folds));
      for (let pass = 0; pass < 4; pass++) {
        out = sanitizeBody(out);
        const styleText = [...out.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('');
        assert.doesNotMatch(styleText, /</, `${folds}-fold, pass ${pass + 1}: ${out}`);
        assert.doesNotMatch(out, /<img/, `${folds}-fold, pass ${pass + 1}: ${out}`);
      }
    }
  }
});

test('keeps page-level CSS verbatim and escapes SVG style text', () => {
  const pageCss = '<style>.a > .b{color:red}.c{&:hover{color:blue}}</style>';
  assert.equal(sanitizeBody(pageCss), pageCss);
  assert.equal(
    sanitizeBody('<svg><style>.a > .b{fill:red}</style></svg>'),
    '<svg><style>.a &gt; .b{fill:red}</style></svg>',
  );
});

test('scheme-checks form actions and SVG references and drops password inputs', () => {
  assert.equal(sanitizeBody('<form action="javascript:alert(1)"></form>'), '<form></form>');
  assert.equal(sanitizeBody('<svg><use xlink:href="javascript:alert(1)"></use></svg>'), '<svg><use></use></svg>');
  assert.equal(sanitizeBody('<form><input type="password" name="p"></form>'), '<form></form>');
});
