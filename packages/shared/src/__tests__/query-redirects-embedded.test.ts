import { describe, expect, it } from 'vitest';
import { embeddedQueryRedirectTarget, groupQueryRedirects, injectQueryRedirectScript, readEmbeddedQueryRedirects } from '../query-redirects.js';

const page = (rules: Array<{ from_path: string; to_path: string }>) =>
  injectQueryRedirectScript('<html><head></head><body></body></html>', [...groupQueryRedirects(rules).values()].flat())!;

describe('embeddedQueryRedirectTarget', () => {
  const html = page([
    { from_path: '/?p=1', to_path: '/a/' },
    { from_path: '/?p=1&lang=en', to_path: '/en/a/' },
    { from_path: '/caffè/?lang=it', to_path: 'https://other.example/x' },
  ]);

  it('reads back the rules the build embedded', () => {
    expect(readEmbeddedQueryRedirects(html)).toHaveLength(3);
  });

  it('matches like the published script: exact params, extra params ignored, most specific first', () => {
    expect(embeddedQueryRedirectTarget(html, 'https://s.example/?p=1&utm_source=x')).toBe('https://s.example/a/');
    expect(embeddedQueryRedirectTarget(html, 'https://s.example/index.html?lang=en&p=1')).toBe('https://s.example/en/a/');
    expect(embeddedQueryRedirectTarget(html, 'https://s.example/?p=2')).toBeNull();
    expect(embeddedQueryRedirectTarget(html, 'https://s.example/caff%C3%A8?lang=it')).toBe('https://other.example/x');
  });

  it('returns null for documents without the script', () => {
    expect(embeddedQueryRedirectTarget('<html><head></head></html>', 'https://s.example/?p=1')).toBeNull();
  });
});
