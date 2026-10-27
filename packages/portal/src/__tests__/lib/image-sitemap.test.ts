import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildCoreBlockRegistry } from '@typeroll/shared';
import type { Block, ContentType, Page } from '@typeroll/shared';
import { imageSitemapEntry, pageSitemapImages } from '../../../../site-template/src/lib/image-sitemap';
const contentType = { id: 'article', fields: [
  { name: 'featured_image', type: 'image' }, { name: 'secret', type: 'image', rendered: false },
  { name: 'gallery', type: 'array', fields: [{ name: 'photo', type: 'image' }] },
] } as ContentType;
const image = (src: string): Block => ({ id: src, type: 'core/image', data: { src } });
const page = { id: 'article', title: 'Article', slug: 'article', status: 'published', content_mode: 'blocks', fields: {
  featured_image: '/media/featured.jpg', secret: '/private.jpg', gallery: [{ photo: '//cdn.example/extra.png' }],
}, blocks: [{ id: 'section', type: 'core/section', data: {}, children: [image('/media/body.jpg')], slots: [[image('/media/slot.jpg')]] }] } as Page;
const options = { pageUrl: 'https://example.test/tips/article/', contentType, registry: buildCoreBlockRegistry() };

test('includes public typed fields, children, slots, HTML and responsive image sources', () => {
  const copy = structuredClone(page);
  copy.blocks!.push({ ...image('/media/body.jpg'), responsive: { desktop: { data_overrides: { src: '/media/wide.jpg' } } } });
  copy.blocks!.push({ id: 'prose', type: 'core/prose', data: { html: '<picture><source srcset="/media/source.webp 1x, /media/source2.webp 2x"><img src="relative.jpg?a=1&amp;b=2" srcset="data:image/png;base64,ABC 1x, /media/real.png 2x"></picture>' } });
  copy.blocks!.push({ id: 'html', type: 'core/html', data: { html: '<img src="/media/custom.svg">' } });
  assert.deepEqual(pageSitemapImages(copy, options), [
    'https://example.test/media/featured.jpg', 'https://cdn.example/extra.png',
    'https://example.test/media/body.jpg', 'https://example.test/media/slot.jpg', 'https://example.test/media/wide.jpg',
    'https://example.test/media/source.webp', 'https://example.test/media/source2.webp',
    'https://example.test/tips/article/relative.jpg?a=1&b=2', 'https://example.test/media/real.png', 'https://example.test/media/custom.svg',
  ]);
});

test('resolves template Page bindings without exposing private fields or unresolved tokens', () => {
  const result = pageSitemapImages(page, { ...options, template: [
    image('{{page.featured_image}}'), image('{{page.fields.secret}}'), image('{{item.photo}}'),
  ] });
  assert.equal(result.filter(item => item.endsWith('/featured.jpg')).length, 1);
  assert.ok(!result.some(item => /private|%7B|secret/.test(item)));
});

test('keeps HTML-mode images and excludes unsafe URLs, stale block bodies and unused media', () => {
  const result = pageSitemapImages({ ...page, fields: {}, content_mode: 'html', og_image: '/social.jpg', html_content: '<img src="/one.jpg"><img src="data:image/png;base64,abc"><img src="javascript:alert(1)"><img src="https://user:secret@example.com/image.jpg">' }, options);
  assert.deepEqual(result, ['https://example.test/social.jpg', 'https://example.test/one.jpg']);
});

test('includes referenced global blocks once and terminates cycles', () => {
  const ref: Block = { id: 'ref', type: 'core/global_block', data: { global_block_id: 'shared' } };
  assert.ok(pageSitemapImages({ ...page, blocks: [ref] }, { ...options, partials: [{ id: 'shared', name: 'shared', kind: 'free', status: 'published', content_mode: 'blocks', blocks: [image('/global.jpg'), ref] }] }).includes('https://example.test/global.jpg'));
});

test('escapes XML once and omits pages without images', () => {
  assert.equal(imageSitemapEntry('https://example.test/article/', []), '');
  assert.match(imageSitemapEntry('https://example.test/article/', ['https://cdn.example/a.jpg?x=1&y=2']), /x=1&amp;y=2/);
});
