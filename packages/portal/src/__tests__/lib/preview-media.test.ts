import { describe, it, expect } from 'vitest';
import { rewritePreviewMediaUrls, rewritePreviewFileLinks } from '../../lib/preview-media';
import type { Media } from '@typeroll/shared';

it('opens imported PDF links through private preview media without confusing foreign files or site navigation', () => {
  const media = [{ id: 'pdf', mime_type: 'application/pdf', cdn_url: 'https://portal.test/api/sites/mysite/media/pdf/content', public_path: '/media/template.pdf', source_aliases: ['https://live.test/media/template.pdf'] }] as Media[];
  const source = '<a href="/preview/mysite/media/template.pdf?t=review#page=2">Template</a><a href="https://foreign.test/media/template.pdf">Foreign</a>';
  const html = rewritePreviewFileLinks(source, media, '/preview/mysite');
  expect(html).toContain('href="https://portal.test/api/sites/mysite/media/pdf/content#page=2"');
  expect(html).toContain('data-preview-file-link="1" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('href="https://foreign.test/media/template.pdf"');
  expect(html).toContain('>Foreign</a>');
  expect(rewritePreviewMediaUrls(html, 'mysite', TOKEN)).toContain('/preview/mysite/media/pdf?token=');
});

const TOKEN = 'tok.en/+=';
const signed = (id: string) => `/preview/mysite/media/${id}?token=${encodeURIComponent(TOKEN)}`;

it('opens absolute private PDF links with a fragment through the signed preview route', () => {
  const url = 'https://portal.test/api/sites/mysite/media/pdf/content';
  const media = [{ id: 'pdf', mime_type: 'application/pdf', cdn_url: url }] as Media[];
  const html = rewritePreviewFileLinks(`<a href="${url}#page=2">Template</a>`, media);
  expect(html).toContain('data-preview-file-link="1" target="_blank" rel="noopener noreferrer"');
  expect(rewritePreviewMediaUrls(html, 'mysite', TOKEN)).toContain(`href="${signed('pdf')}#page=2"`);
});

it('matches the complete absolute PDF alias before its fragment without reusing foreign paths', () => {
  const media = [{ id: 'pdf', mime_type: 'application/pdf', cdn_url: 'https://portal.test/api/sites/mysite/media/pdf/content',
    source_aliases: ['https://live.test/media/template.pdf?edition=2', 'https://live.test/media/legacy.pdf#chapter'] }] as Media[];
  const html = rewritePreviewFileLinks('<a href="https://live.test/media/template.pdf?edition=2#page=3">Template</a><a href="https://foreign.test/media/template.pdf?edition=2#page=3">Foreign</a><a href="https://live.test/media/legacy.pdf#chapter">Legacy</a>', media);
  expect(html).toContain('href="https://portal.test/api/sites/mysite/media/pdf/content#page=3"');
  expect(html).toContain('href="https://portal.test/api/sites/mysite/media/pdf/content#chapter"');
  expect(html).toContain('href="https://foreign.test/media/template.pdf?edition=2#page=3"');
});

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

it('explains unavailable PDF paths and links to the published file only when its hostname is known', () => {
  const html = '<a href="/preview/mysite/media/missing.pdf?t=review">Template</a>';
  const pending = rewritePreviewFileLinks(html, [], '/preview/mysite');
  expect(pending).toContain('aria-disabled="true"');
  expect(pending).toContain('only available on the published website');
  const live = rewritePreviewFileLinks(html, [], '/preview/mysite', 'https://live.test');
  expect(live).toContain('href="https://live.test/media/missing.pdf"');
  expect(live).not.toContain('?t=review');
});
