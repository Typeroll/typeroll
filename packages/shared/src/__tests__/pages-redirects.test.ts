import { describe, expect, it } from 'vitest';
import { pagesRedirectsFile, pagesBulkRedirects } from '../pages-redirects';
import { expandRedirectsForTrailingSlashPolicy } from '../redirect-patterns';
import { checkPagesRedirects } from '../pages-redirect-limits.mjs';

const fixed = (count: number) => Array.from({ length: count }, (_, i) => ({ from_path: `/old-${i}.html`, to_path: `/new-${i}/`, status_code: 301 as const }));
describe('Cloudflare Pages emitted redirect capacity', () => {
  it('retains every expanded source across static Pages and exact Bulk overflow', () => {
    const rules = [...fixed(1999),
      { from_path: '/old', to_path: '/new?fixed=1#part', status_code: 302 as const },
      { from_path: '/old/', to_path: '/distinct/', status_code: 301 as const },
      { from_path: '/åäö/', to_path: 'https://outside.test/target#part', status_code: 301 as const }];
    const text = pagesRedirectsFile(rules, {}, { domain: 'example.test', domain_alias: 'www.example.test' }, { bulkOverflow: true });
    expect(checkPagesRedirects(text)).toMatchObject({ static: 2000, dynamic: 1 });
    const bulk = pagesBulkRedirects(text);
    const actual = text.split('\n').filter(line => line.startsWith('/') && !line.startsWith('//'));
    actual.push(...bulk.map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`));
    const expected = expandRedirectsForTrailingSlashPolicy(rules, 'always').map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
    expect(actual.sort()).toEqual(expected.sort());
    expect(new Set(bulk.map(rule => rule.from_path)).size).toBe(bulk.length);
  });
  it('does not turn query sources or patterns into broader Bulk matches', () => {
    const text = pagesRedirectsFile([...fixed(2200), { from_path: '/?p=1', to_path: '/article/', status_code: 301 },
      { from_path: '/category/*', to_path: '/new/:splat', status_code: 301 }], {}, {}, { bulkOverflow: true });
    expect(pagesBulkRedirects(text)).toHaveLength(202); // pattern index slash aliases are exact too
    expect(pagesBulkRedirects(text).every(rule => !/[?*:]/.test(rule.from_path))).toBe(true);
    expect(text.includes('/category/* /new/:splat/ 301')).toBe(true);
    const patterns = Array.from({ length: 101 }, (_, i) => ({ from_path: `/archive-${i}/*`, to_path: '/new/:splat', status_code: 301 as const }));
    expect(() => pagesRedirectsFile(patterns, {}, {}, { bulkOverflow: true })).toThrow('101 dynamic');
  });
  it('refuses corrupt overflow and retains the normal Pages guard without opt-in', () => {
    expect(() => pagesRedirectsFile(fixed(2001))).toThrow('2001 static');
    for (const rule of [ { from_path: '/x/*', to_path: '/new', status_code: 301 }, { from_path: '/?x=1', to_path: '/new', status_code: 301 },
      { from_path: '//other.test', to_path: '/new', status_code: 301 }, { from_path: '/x', to_path: 'javascript:evil', status_code: 301 } ]) {
      expect(() => pagesBulkRedirects('# typeroll-bulk-redirect-v1 ' + JSON.stringify(rule))).toThrow();
    }
  });
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
