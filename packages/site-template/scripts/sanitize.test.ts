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
