import { describe, expect, it } from 'vitest';
import { socialMetadata } from '../social-metadata.js';
import type { Page, SiteSettings, ContentType } from '../types.js';
const page = { title: 'Document', seo_title: 'SEO', seo_description: 'Search description', fields: { featured_image: '/media/cat.jpg', featured_image_alt: 'A cat' } } as unknown as Page;
const settings = { default_seo_suffix: ' – Site', default_og_image: '/default.jpg', logo: '/logo.jpg', language: 'sv' } as SiteSettings;
const type = { fields: [{ name: 'featured_image', type: 'image' }, { name: 'featured_image_alt', type: 'text' }], schema_field_map: { featured_image: 'image' } } as unknown as ContentType;
describe('social metadata', () => {
  it('uses the public mapped image and its corresponding alt before the site fallback', () => {
    expect(socialMetadata(page, settings, type)).toEqual({ type: 'website', title: 'SEO – Site', description: 'Search description', image: '/media/cat.jpg', imageAlt: 'A cat', locale: 'sv_SE' });
  });
  it('resolves relative images on the publication origin, independently of canonical overrides', () => {
    expect(socialMetadata({ ...page, canonical_url: 'https://original.test/post/' }, settings, type, 'https://site.test/article/').image).toBe('https://site.test/media/cat.jpg');
  });
  it('keeps explicit social metadata separate from document metadata', () => {
    expect(socialMetadata({ ...page, og_title: 'Share', og_description: 'Sharing', og_image: '/chosen.jpg', seo_image_alt: 'Chosen' }, settings, type)).toMatchObject({ title: 'Share', description: 'Sharing', image: '/chosen.jpg', imageAlt: 'Chosen' });
  });
  it('does not expose private mapped fields or alt text', () => {
    expect(socialMetadata(page, settings, { ...type, fields: type.fields.map(field => ({ ...field, rendered: false })) })).toMatchObject({ image: '/default.jpg', imageAlt: '' });
  });
  it('uses site defaults, then logo, and treats whitespace overrides as empty', () => {
    expect(socialMetadata({ ...page, fields: {}, og_title: ' ', og_description: '', append_seo_suffix: false }, { ...settings, default_og_image: '' }, type)).toMatchObject({ title: 'SEO', description: 'Search description', image: '/logo.jpg' });
  });
});

it('uses article sharing type for content-type articles', () => {
  for (const schema_type of ['BlogPosting', 'Article', 'NewsArticle'])
    expect(socialMetadata(page, settings, { ...type, schema_type }).type).toBe('article');
});

it('describes the site default share image with its own alt text, never the first body image (AT-10)', () => {
  const alt = (url: string) => ({ 'https://site.test/default.jpg': 'Moving van', 'https://site.test/chosen.jpg': 'Chosen in library' } as Record<string, string>)[url];
  const bare = { ...page, fields: {}, html_content: '<p><img src="/other.jpg" alt="Other"></p>' } as Page;
  expect(socialMetadata(bare, settings, type, 'https://site.test/a/', alt)).toMatchObject({ image: 'https://site.test/default.jpg', imageAlt: 'Moving van' });
  // Without a library alt text the default image gets none rather than another image's.
  expect(socialMetadata(bare, settings, type, 'https://site.test/a/').imageAlt).toBe('');
  expect(socialMetadata({ ...bare, seo_image_alt: 'Override' }, settings, type, 'https://site.test/a/', alt).imageAlt).toBe('Override');
  // An explicit page image prefers its library alt text, then the body.
  expect(socialMetadata({ ...bare, og_image: '/chosen.jpg' }, settings, type, 'https://site.test/a/', alt).imageAlt).toBe('Chosen in library');
  expect(socialMetadata({ ...bare, og_image: '/chosen.jpg' }, settings, type, 'https://site.test/a/').imageAlt).toBe('Other');
});
