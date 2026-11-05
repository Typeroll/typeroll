import { expect, it } from 'vitest';
import { r2Endpoint } from '../../lib/r2-endpoint';

it('uses the EU endpoint only for buckets listed in R2_EU_BUCKETS', () => {
  const env = { R2_EU_BUCKETS: 'typeroll-production-private-drafts, other' };
  expect(r2Endpoint('a'.repeat(32), 'typeroll-production-private-drafts', env)).toBe(`https://${'a'.repeat(32)}.eu.r2.cloudflarestorage.com`);
  expect(r2Endpoint('a'.repeat(32), 'legacy-media', env)).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  expect(r2Endpoint('a'.repeat(32), undefined, env)).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
});
