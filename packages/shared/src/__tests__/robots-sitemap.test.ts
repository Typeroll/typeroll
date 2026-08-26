import { describe, it, expect } from 'vitest';
import { withSitemapLines } from '../robots-sitemap.js';

describe('withSitemapLines', () => {
  const urls = ['https://example.com/sitemap.xml', 'https://example.com/sitemap-images.xml'];

  it('emits default robots when no custom content', () => {
    const out = withSitemapLines(undefined, urls);
    expect(out).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap-images.xml\n',
    );
  });

  it('treats empty/whitespace-only custom as no custom', () => {
    expect(withSitemapLines('', urls)).toContain('User-agent: *');
    expect(withSitemapLines('   \n  ', urls)).toContain('User-agent: *');
  });

  it('appends Sitemap lines when custom robots has none', () => {
    const custom = 'User-agent: *\nDisallow: /admin/';
    const out = withSitemapLines(custom, urls);
    expect(out).toContain('User-agent: *');
    expect(out).toContain('Disallow: /admin/');
    expect(out).toContain('Sitemap: https://example.com/sitemap.xml');
    expect(out).toContain('Sitemap: https://example.com/sitemap-images.xml');
  });

  it('does not touch custom robots that already has a Sitemap line', () => {
    const custom = 'User-agent: *\nDisallow: /admin/\nSitemap: https://custom.example.com/sitemap.xml';
    const out = withSitemapLines(custom, urls);
    expect(out).toContain('Sitemap: https://custom.example.com/sitemap.xml');
    expect(out).not.toContain('Sitemap: https://example.com/sitemap.xml');
    expect(out).not.toContain('Sitemap: https://example.com/sitemap-images.xml');
  });

  it('matches Sitemap: case-insensitively', () => {
    const custom = 'User-agent: *\nsitemap: https://custom.example.com/sitemap.xml';
    const out = withSitemapLines(custom, urls);
    expect(out).not.toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('ends with a newline', () => {
    expect(withSitemapLines(undefined, urls).endsWith('\n')).toBe(true);
    expect(withSitemapLines('User-agent: *\nDisallow: /', urls).endsWith('\n')).toBe(true);
    expect(withSitemapLines('User-agent: *\nSitemap: https://x/sitemap.xml', urls).endsWith('\n')).toBe(true);
  });
});
