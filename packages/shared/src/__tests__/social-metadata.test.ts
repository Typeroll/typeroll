import { describe, expect, it } from 'vitest';
import { socialMetadata } from '../social-metadata.js';
import type { Page, SiteSettings, ContentType } from '../types.js';
const page = { title: 'Document', seo_title: 'SEO', seo_description: 'Search description', fields: { featured_image: '/media/cat.jpg', featured_image_alt: 'A cat' } } as unknown as Page;
const settings = { default_seo_suffix: ' – Site', default_og_image: '/default.jpg', logo: '/logo.jpg', language: 'sv' } as SiteSettings;
const type = { fields: [{ name: 'featured_image', type: 'image' }, { name: 'featured_image_alt', type: 'text' }], schema_field_map: { featured_image: 'image' } } as unknown as ContentType;
describe('social metadata', () => {
  it('uses the public mapped image and its corresponding alt before the site fallback', () => {
    expect(socialMetadata(page, settings, type)).toEqual({ title: 'SEO – Site', description: 'Search description', image: '/media/cat.jpg', imageAlt: 'A cat', locale: 'sv_SE' });
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
