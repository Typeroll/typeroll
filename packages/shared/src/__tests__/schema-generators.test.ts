import { describe, it, expect } from 'vitest';
import { buildCollectionItemSchema, buildPageSchema } from '../schema-generators.js';
import type { CollectionDef, CollectionItem, Page, SiteSettings } from '../types.js';

const site: SiteSettings = {
  site_name: 'Autopilot',
  tagline: 'AI agency',
  colors: {
    primary: '#000', secondary: '#111', accent: '#222',
    background: '#fff', surface: '#eee', text: '#000', text_light: '#444',
  },
  fonts: { heading: 'Inter', body: 'Inter', size_base: 16 },
  organization: { name: 'Autopilot Sweden AB', logo: 'https://cdn/logo.png' },
};

describe('buildPageSchema', () => {
  const basePage: Page = {
    id: 'about',
    title: 'About',
    slug: 'about',
    content_mode: 'html',
    status: 'published',
  };

  it('returns null when schema_type is missing', () => {
    expect(buildPageSchema(basePage, site, 'https://x/about/')).toBeNull();
  });

  it('emits generic envelope for unknown types', () => {
    const page = { ...basePage, schema_type: 'Course', seo_description: 'A short course.' };
    const ld = JSON.parse(buildPageSchema(page, site, 'https://x/about/')!);
    expect(ld['@type']).toBe('Course');
    expect(ld.name).toBe('About');
    expect(ld.url).toBe('https://x/about/');
    expect(ld.description).toBe('A short course.');
  });

  it('builds Service with nested Offer', () => {
    const page: Page = {
      ...basePage,
      schema_type: 'Service',
      service: {
        price: 15000,
        price_currency: 'SEK',
        duration: 'PT2W',
        description: 'Two-week sprint',
        url: 'https://x/about/',
      },
    };
    const ld = JSON.parse(buildPageSchema(page, site, 'https://x/about/')!);
    expect(ld['@type']).toBe('Service');
    expect(ld.description).toBe('Two-week sprint');
    expect(ld.provider).toEqual({ '@type': 'Organization', name: 'Autopilot Sweden AB' });
    expect(ld.offers).toEqual({
      '@type': 'Offer',
      price: 15000,
      priceCurrency: 'SEK',
      url: 'https://x/about/',
    });
    expect(ld.termsOfService).toBe('PT2W');
  });

  it('omits offer when service.price is missing', () => {
    const page: Page = {
      ...basePage,
      schema_type: 'Service',
      service: { description: 'Free consult' },
    };
    const ld = JSON.parse(buildPageSchema(page, site, 'https://x/free/')!);
    expect(ld.offers).toBeUndefined();
    expect(ld.description).toBe('Free consult');
  });
});

describe('buildCollectionItemSchema', () => {
  it('returns null when collection.schema_type is missing', () => {
    const coll: CollectionDef = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], created_at: '2024-01-01',
    };
    const item: CollectionItem = { id: 'a', status: 'published', created_at: 'x', updated_at: 'y' };
    expect(buildCollectionItemSchema(item, coll, site, 'https://x/blog/a/')).toBeNull();
  });

  it('maps BlogPosting fields with built-in defaults', () => {
    const coll: CollectionDef = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], created_at: '2024-01-01',
      schema_type: 'BlogPosting',
    };
    const item: CollectionItem = {
      id: 'a',
      status: 'published',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      title: 'My post',
      body: '<p>Hello world</p>',
      excerpt: 'Hello',
      featured_image: 'https://cdn/x.png',
      author: 'Tomas',
    };
    const ld = JSON.parse(
      buildCollectionItemSchema(item, coll, site, 'https://x/blog/a/')!,
    );
    expect(ld['@type']).toBe('BlogPosting');
    expect(ld.headline).toBe('My post');
    expect(ld.articleBody).toBe('<p>Hello world</p>');
    expect(ld.description).toBe('Hello');
    expect(ld.image).toBe('https://cdn/x.png');
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Tomas' });
    expect(ld.datePublished).toBe('2024-01-01T00:00:00Z');
    expect(ld.dateModified).toBe('2024-01-02T00:00:00Z');
    expect(ld.publisher).toEqual({
      '@type': 'Organization',
      name: 'Autopilot Sweden AB',
      logo: { '@type': 'ImageObject', url: 'https://cdn/logo.png' },
    });
  });

  it('honours schema_field_map override for niche fields', () => {
    const coll: CollectionDef = {
      id: 'podcast', name: 'podcast',
      label_singular: 'Episode', label_plural: 'Episodes',
      fields: [], created_at: '2024-01-01',
      schema_type: 'PodcastEpisode',
      schema_field_map: { mp3: 'contentUrl', show_notes_html: 'description' },
    };
    const item: CollectionItem = {
      id: 'ep1',
      status: 'published',
      created_at: 'c', updated_at: 'u',
      title: 'Ep 1',
      mp3: 'https://cdn/ep1.mp3',
      show_notes_html: '<p>Notes</p>',
      duration: 'PT45M',
    };
    const ld = JSON.parse(buildCollectionItemSchema(item, coll, site, 'https://x/podcast/ep1/')!);
    expect(ld['@type']).toBe('PodcastEpisode');
    expect(ld.name).toBe('Ep 1');
    expect(ld.contentUrl).toBe('https://cdn/ep1.mp3');
    expect(ld.description).toBe('<p>Notes</p>');
    expect(ld.timeRequired).toBe('PT45M');
  });

  it('emits arbitrary type unknown to the builtin map (Course)', () => {
    const coll: CollectionDef = {
      id: 'courses', name: 'courses',
      label_singular: 'Course', label_plural: 'Courses',
      fields: [], created_at: '2024-01-01',
      schema_type: 'Course',
    };
    const item: CollectionItem = {
      id: 'c1', status: 'published', created_at: 'c', updated_at: 'u',
      title: 'Intro',
      provider: 'Acme',
    };
    const ld = JSON.parse(buildCollectionItemSchema(item, coll, site, 'https://x/courses/c1/')!);
    expect(ld['@type']).toBe('Course');
    expect(ld.name).toBe('Intro');
    expect(ld.provider).toEqual({ '@type': 'Organization', name: 'Acme' });
  });

  it('passes through object values verbatim (author-as-object, custom sub-schemas)', () => {
    const coll: CollectionDef = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], created_at: '2024-01-01',
      schema_type: 'BlogPosting',
    };
    const item: CollectionItem = {
      id: 'a', status: 'published', created_at: 'c', updated_at: 'u',
      title: 'X',
      author: { '@type': 'Person', name: 'Tomas', url: 'https://x' },
    };
    const ld = JSON.parse(buildCollectionItemSchema(item, coll, site, 'https://x/blog/a/')!);
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Tomas', url: 'https://x' });
  });
});
