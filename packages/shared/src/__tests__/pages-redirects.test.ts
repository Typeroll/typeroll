import { expect, it } from 'vitest';
import { buildPagesRedirects, validatePagesRedirects } from '../pages-redirects.js';
import { largeRedirectInventory } from '../../../../scripts/fixtures/large-redirects.mjs';

it('preserves a 936-rule migration above 128 KiB, with slash aliases and the hundredth hostname pattern', () => {
  const rules = largeRedirectInventory();
  const file = buildPagesRedirects({ domain: 'example.com', domain_alias: 'www.example.com' }, rules);
  const counts = validatePagesRedirects(file);
  expect(counts.bytes).toBeGreaterThan(128 * 1024);
  expect(counts.static).toBeGreaterThan(837);
  expect(counts.static).toBeLessThanOrEqual(2000);
  expect(counts.dynamic).toBe(100);
  for (const rule of rules) expect(file).toContain(rule.from_path + ' ');
});

it('enforces static and dynamic limits separately on emitted declarations', () => {
  const exact = Array.from({ length: 2000 }, (_, i) => `/old-${i}.html /new/ 301\n`).join('');
  const patterns = Array.from({ length: 100 }, (_, i) => `/old-${i}/* /new/:splat 301\n`).join('');
  expect(validatePagesRedirects(exact + patterns)).toMatchObject({ static: 2000, dynamic: 100 });
  expect(() => validatePagesRedirects(exact + '/extra.html /new/ 301')).toThrow('2001 static');
  expect(() => validatePagesRedirects(patterns + '/:slug /new/:slug 301')).toThrow('101 dynamic');
  expect(validatePagesRedirects('https://old.example.com/x https://new.example.com/x 301\n# comment\n')).toMatchObject({ static: 1, dynamic: 0 });
});

it('reports the exact overlong declaration and includes generated slash aliases in the limit', () => {
  const line = '/old /' + 'x'.repeat(990) + ' 301';
  expect([...line]).toHaveLength(1000);
  expect(() => validatePagesRedirects(line)).not.toThrow();
  expect(() => validatePagesRedirects('# comment\n' + line + 'x')).toThrow('_redirects:2');
  expect(() => buildPagesRedirects({}, Array.from({ length: 51 }, (_, i) => ({ from_path: `/old-${i}/:slug`, to_path: '/new/:slug', status_code: 301 })))).toThrow('102 dynamic');
});
