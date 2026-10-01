import { describe, it, expect } from 'vitest';
import { rewritePreviewMediaUrls } from '../../lib/preview-media';

const TOKEN = 'tok.en/+=';
const signed = (id: string) => `/preview/mysite/media/${id}?token=${encodeURIComponent(TOKEN)}`;

describe('rewritePreviewMediaUrls', () => {
  it('rewrites UUID media ids', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const html = `<img src="https://app.typeroll.com/api/sites/mysite/media/${id}/content">`;
    expect(rewritePreviewMediaUrls(html, 'mysite', TOKEN)).toBe(`<img src="${signed(id)}">`);
  });

  it('rewrites legacy and imported media ids that are not UUIDs', () => {
    const html = '<img src="https://app.typeroll.com/api/sites/mysite/media/PE5N4fGk0h3DcmBjJ8vq/content" alt="x">';
    expect(rewritePreviewMediaUrls(html, 'mysite', TOKEN)).toBe(`<img src="${signed('PE5N4fGk0h3DcmBjJ8vq')}" alt="x">`);
  });

  it('matches any origin and origin-relative references', () => {
    const html = [
      '<img src="http://localhost:4321/api/sites/mysite/media/abc123/content">',
      '<img srcset="/api/sites/mysite/media/abc123/content 1x, https://cms.example/api/sites/mysite/media/def_456/content 2x">',
      '<div style="background:url(/api/sites/mysite/media/abc123/content)"></div>',
    ].join('');
    const out = rewritePreviewMediaUrls(html, 'mysite', TOKEN);
    expect(out).not.toContain('/api/sites/');
    expect(out).toContain(`srcset="${signed('abc123')} 1x, ${signed('def_456')} 2x"`);
    expect(out).toContain(`url(${signed('abc123')})`);
  });

  it('leaves other sites and non-media API paths untouched', () => {
    const html = [
      '<img src="https://app.typeroll.com/api/sites/othersite/media/abc123/content">',
      '<a href="/api/sites/mysite/media/abc123">meta</a>',
      '<img src="/api/sites/mysite/media/abc123/contentx">',
    ].join('');
    expect(rewritePreviewMediaUrls(html, 'mysite', TOKEN)).toBe(html);
  });
});
