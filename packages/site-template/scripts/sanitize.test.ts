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
