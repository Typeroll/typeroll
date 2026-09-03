import { describe, expect, it } from 'vitest';
import { cleanWordPressHtml } from '../../lib/wp/clean-html';
import { resolveSourceRedirectsInHtml } from '../../lib/wp/internal-links';

describe('WordPress link rewriting', () => {
  it('rewrites attachment wrappers to the transferred image URL', () => {
    const oldImage = 'https://old.example.com/wp-content/uploads/photo.jpg';
    const cdnImage = 'https://cdn.example.com/photo.jpg';
    const html = cleanWordPressHtml(
      `<a href="https://old.example.com/photo/"><img src="${oldImage}" alt="Photo"></a>`,
      { mediaMap: new Map([[oldImage, cdnImage]]), sourceOrigin: 'https://old.example.com' },
    );
    expect(html).toContain(`href="${cdnImage}"`);
    expect(html).toContain(`src="${cdnImage}"`);
  });

  it('follows and caches source redirects before import', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return { ok: true, redirected: true, url: 'https://old.example.com/new/', body: null } as Response;
    }) as typeof fetch;
    const result = await resolveSourceRedirectsInHtml(
      '<a href="/old">one</a><a href="/old">two</a>',
      'https://old.example.com',
      { fetchImpl },
    );
    expect(result).toContain('href="/new/"');
    expect(requests).toBe(1);
  });
});
