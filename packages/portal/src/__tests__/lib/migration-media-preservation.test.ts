import { expect, it } from 'vitest';
import { cleanWordPressHtml } from '../../lib/wp/clean-html';
import { htmlToBlocks } from '../../lib/html-to-blocks';

it('restores lazy source media before cleaning and does not import its noscript duplicate', () => {
  const html = cleanWordPressHtml('<img src="placeholder.gif" data-lazy-src="https://old.example/photo.jpg" alt="Packing"><noscript><img src="https://old.example/photo.jpg" alt="Packing"></noscript>', {
    mediaMap: new Map([['https://old.example/photo.jpg', 'https://media.example/photo.jpg']]),
  });
  expect(html.match(/<img/g)).toHaveLength(1);
  expect(html).toContain('src="https://media.example/photo.jpg"');
  expect(html).not.toContain('placeholder');
  expect(JSON.stringify(htmlToBlocks(html).blocks)).toContain('https://media.example/photo.jpg');
});

it('preserves lazy video embeds and rewrites picture sources as well as fallback images', () => {
  const html = cleanWordPressHtml('<picture><source data-srcset="https://old.example/a.webp 800w"><img data-src="https://old.example/a.jpg"></picture><iframe data-src="https://www.youtube.com/embed/abc" title="Instructions"></iframe>', {
    mediaMap: new Map([['https://old.example/a.webp', '/a.webp'], ['https://old.example/a.jpg', '/a.jpg']]),
  });
  expect(html).toContain('srcset="/a.webp 800w"');
  expect(html).toContain('src="/a.jpg"');
  expect(html).toContain('src="https://www.youtube.com/embed/abc"');
});

it('uses the source page for relative media and decodes query parameters before transfer', async () => {
  const { extractImageUrls } = await import('../../lib/wp/extract-image-urls');
  const source = '<img data-src="photo.jpg?w=800&amp;format=webp">';
  const baseUrl = 'https://source.example/article/';
  expect(extractImageUrls(source, { baseUrl }).map(image => image.url)).toEqual(['https://source.example/article/photo.jpg?w=800&format=webp']);
  expect(cleanWordPressHtml(source, { sourceOrigin: 'https://source.example', mediaBaseUrl: baseUrl,
    mediaMap: new Map([['https://source.example/article/photo.jpg?w=800&format=webp', '/migrated.webp']]),
  })).toContain('src="/migrated.webp"');
});
