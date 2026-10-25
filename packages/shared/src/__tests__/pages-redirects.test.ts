import { describe, expect, it } from 'vitest';
import { pagesRedirectsFile } from '../pages-redirects';
import { checkPagesRedirects } from '../pages-redirect-limits.mjs';

const fixed = (count: number) => Array.from({ length: count }, (_, i) => ({ from_path: `/old-${i}.html`, to_path: `/new-${i}/`, status_code: 301 as const }));
describe('Cloudflare Pages emitted redirect capacity', () => {
  it('supports a 936-rule migration above 128 KiB including media and generated slash aliases', () => {
    const media = Array.from({ length: 702 }, (_, i) => ({ from_path: `/wp-content/uploads/2024/01/${'long-image-name-'.repeat(8)}${i}.jpg`, to_path: `https://media.example.test/site/${'asset-'.repeat(6)}${i}.jpg`, status_code: 301 as const }));
    const slugs = Array.from({ length: 135 }, (_, i) => ({ from_path: `/legacy-${i}`, to_path: `/articles/new-${i}/`, status_code: 301 as const }));
    const patterns = Array.from({ length: 99 }, (_, i) => ({ from_path: `/archive-${i}/*`, to_path: '/articles/:splat', status_code: 301 as const }));
    const text = pagesRedirectsFile([...media, ...slugs, ...patterns]);
    expect(Buffer.byteLength(text)).toBeGreaterThan(128 * 1024);
    expect(checkPagesRedirects(text)).toEqual({ static: 1170, dynamic: 99, total: 1269 });
    expect(text).toContain('/legacy-134/ /articles/new-134/ 301');
  });
  it('counts generated rules and canonical-host rules against the provider limit', () => {
    expect(checkPagesRedirects(pagesRedirectsFile(fixed(2000)))).toMatchObject({ static: 2000 });
    expect(() => pagesRedirectsFile(fixed(2001))).toThrow('2001 static');
    const named = Array.from({ length: 51 }, (_, i) => ({ from_path: `/old-${i}/:slug`, to_path: '/new/:slug', status_code: 301 as const }));
    expect(() => pagesRedirectsFile(named)).toThrow('102 dynamic');
    const patterns = Array.from({ length: 100 }, (_, i) => ({ from_path: `/old-${i}/*`, to_path: '/new/:splat', status_code: 301 as const }));
    expect(() => pagesRedirectsFile(patterns, {}, { domain: 'example.test', domain_alias: 'www.example.test' })).toThrow('101 dynamic');
  });
  it('reports the exact overlong line and accepts a legal Unicode line', () => {
    expect(() => checkPagesRedirects(`/old /${'a'.repeat(1000)} 301`)).toThrow('line 1');
    expect(checkPagesRedirects(`/old /${'å'.repeat(900)} 301`)).toMatchObject({ static: 1 });
  });
});
