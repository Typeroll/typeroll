import { describe, expect, it } from 'vitest';
import { markdownRoutesShadowedByRedirects, withoutMarkdownAlternate } from '../page-markdown.js';

describe('markdownRoutesShadowedByRedirects', () => {
  const routes = ['/index.md', '/blog/index.md', '/blog/first-post/index.md', '/about/index.md'];

  it('finds Markdown files a placeholder rule would answer (FR-04: /blog/:slug)', () => {
    expect([...markdownRoutesShadowedByRedirects(routes, [{ from_path: '/blog/:slug', to_path: '/blog/' }])]).toEqual(['/blog/index.md']);
  });

  it('finds them under a splat and an exact rule too', () => {
    expect([...markdownRoutesShadowedByRedirects(routes, [{ from_path: '/blog/*', to_path: '/news/' }])].sort())
      .toEqual(['/blog/first-post/index.md', '/blog/index.md']);
    expect([...markdownRoutesShadowedByRedirects(routes, [{ from_path: '/about/index.md', to_path: '/about/' }])]).toEqual(['/about/index.md']);
  });

  it('leaves files alone when no rule matches, including query rules', () => {
    expect(markdownRoutesShadowedByRedirects(routes, [{ from_path: '/old/:slug', to_path: '/' }, { from_path: '/?p=1', to_path: '/about/' }]).size).toBe(0);
  });
});

describe('withoutMarkdownAlternate', () => {
  it('removes only the Markdown announcement', () => {
    const html = '<head><link rel="canonical" href="https://x.test/blog/"><link rel="alternate" type="text/markdown" href="https://x.test/blog/index.md"><link rel="alternate" hreflang="sv" href="https://x.test/sv/"></head>';
    expect(withoutMarkdownAlternate(html)).toBe('<head><link rel="canonical" href="https://x.test/blog/"><link rel="alternate" hreflang="sv" href="https://x.test/sv/"></head>');
  });
});
