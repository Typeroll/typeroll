import test from 'node:test';
import assert from 'node:assert/strict';
import { externalRoutesError } from '../packages/shared/src/external-routes.mjs';

test('exact independent route declarations are bounded and normalized', () => {
  assert.equal(externalRoutesError(undefined), null);
  assert.equal(externalRoutesError([]), null);
  assert.equal(externalRoutesError([{ path: '/docs/', owner: 'Docs' }, { path: '/docs/llms.txt', owner: 'Docs' }]), null);
  for (const path of ['/', '//elsewhere/docs', '/docs/*', '/docs?x', '/docs#x', '/docs/../other', '/docs/%2e%2e/other', '/docs/%2f/other', '/docs/%252f/other', '/docs\\other', '/docs//other', '/docs/%', '/docs/ space', '/robots.txt', '/sitemap.xml', '/_redirects', '/index.html']) {
    assert.ok(externalRoutesError([{ path, owner: 'Docs' }]), path);
  }
  for (const value of [null, {}, ['docs'], [{ path: '/docs/', owner: '' }], [{ path: '/docs/', owner: 'Docs', skip: true }], [{ path: '/docs', owner: 'Docs' }, { path: '/docs/', owner: 'Docs' }]]) assert.ok(externalRoutesError(value));
});
