import { describe, it, expect } from 'vitest';
import { buildContentPageSchema, buildPageSchema } from '../schema-generators.js';
import type { ContentType, Page, SiteSettings } from '../types.js';

function makePage(input: Record<string, unknown>): Page {
  const { id = 'page', title = '', slug = 'page', status = 'published', html_content, date_published, date_updated, author, ...fields } = input;
  return { id, title, slug, status, content_mode: 'html', html_content, date_published, date_updated, author, fields } as Page;
}

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

describe('buildContentPageSchema', () => {
  it('returns null when collection.schema_type is missing', () => {
    const coll: ContentType = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], route_template: '/{slug}', created_at: '2024-01-01',
    };
    const item: Page = makePage({ id: 'a', status: 'published', date_published: 'x', date_updated: 'y' });
    expect(buildContentPageSchema(item, coll, site, 'https://x/blog/a/')).toBeNull();
  });

  it('maps BlogPosting fields with built-in defaults', () => {
    const coll: ContentType = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], route_template: '/{slug}', created_at: '2024-01-01',
      schema_type: 'BlogPosting',
    };
    const item: Page = makePage({
      id: 'a',
      status: 'published',
      date_published: '2024-01-01T00:00:00Z',
      date_updated: '2024-01-02T00:00:00Z',
      title: 'My post',
      html_content: '<p>Hello world</p>',
      excerpt: 'Hello',
      featured_image: 'https://cdn/x.png',
      author: 'Tomas',
    });
    const ld = JSON.parse(
      buildContentPageSchema(item, coll, site, 'https://x/blog/a/')!,
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
    const coll: ContentType = {
      id: 'podcast', name: 'podcast',
      label_singular: 'Episode', label_plural: 'Episodes',
      fields: [], route_template: '/{slug}', created_at: '2024-01-01',
      schema_type: 'PodcastEpisode',
      schema_field_map: { mp3: 'contentUrl', show_notes_html: 'description' },
    };
    const item: Page = makePage({
      id: 'ep1',
      status: 'published',
      date_published: 'c', date_updated: 'u',
      title: 'Ep 1',
      mp3: 'https://cdn/ep1.mp3',
      show_notes_html: '<p>Notes</p>',
      duration: 'PT45M',
    });
    const ld = JSON.parse(buildContentPageSchema(item, coll, site, 'https://x/podcast/ep1/')!);
    expect(ld['@type']).toBe('PodcastEpisode');
    expect(ld.name).toBe('Ep 1');
    expect(ld.contentUrl).toBe('https://cdn/ep1.mp3');
    expect(ld.description).toBe('<p>Notes</p>');
    expect(ld.timeRequired).toBe('PT45M');
  });

  it('emits arbitrary type unknown to the builtin map (Course)', () => {
    const coll: ContentType = {
      id: 'courses', name: 'courses',
      label_singular: 'Course', label_plural: 'Courses',
      fields: [], route_template: '/{slug}', created_at: '2024-01-01',
      schema_type: 'Course',
    };
    const item: Page = makePage({
      id: 'c1', status: 'published', date_published: 'c', date_updated: 'u',
      title: 'Intro',
      provider: 'Acme',
    });
    const ld = JSON.parse(buildContentPageSchema(item, coll, site, 'https://x/courses/c1/')!);
    expect(ld['@type']).toBe('Course');
    expect(ld.name).toBe('Intro');
    expect(ld.provider).toEqual({ '@type': 'Organization', name: 'Acme' });
  });

  it('passes through object values verbatim (author-as-object, custom sub-schemas)', () => {
    const coll: ContentType = {
      id: 'blog', name: 'blog',
      label_singular: 'Post', label_plural: 'Posts',
      fields: [], route_template: '/{slug}', created_at: '2024-01-01',
      schema_type: 'BlogPosting',
    };
    const item: Page = makePage({
      id: 'a', status: 'published', date_published: 'c', date_updated: 'u',
      title: 'X',
      author: { '@type': 'Person', name: 'Tomas', url: 'https://x' },
    });
    const ld = JSON.parse(buildContentPageSchema(item, coll, site, 'https://x/blog/a/')!);
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Tomas', url: 'https://x' });
  });
});


it('mapped schema includes only explicit public facts and preserves the canonical envelope', () => {
  const page = makePage({ title: 'Supplier', website: 'https://supplier.example', claim_email: 'private@example.com', internal_code: 'secret', date_updated: '2026-09-16' });
  const contentType: ContentType = { id: 'suppliers', name: 'suppliers', label_singular: 'Supplier', label_plural: 'Suppliers', route_template: '/companies/{slug}', created_at: '', schema_type: 'Organization', schema_field_mode: 'mapped',
    schema_field_map: { title: 'name', website: 'sameAs', claim_email: 'email', internal_code: 'url' },
    fields: [{ name: 'claim_email', type: 'email', label: 'Private', rendered: false }],
  };
  expect(JSON.parse(buildContentPageSchema(page, contentType, site, 'https://directory.example/company/')!)).toEqual({
    '@context': 'https://schema.org', '@type': 'Organization', url: 'https://directory.example/company/', name: 'Supplier', sameAs: 'https://supplier.example',
  });
});


it('explicitly maps Page dates without leaking other fields in mapped mode', () => {
  const page = makePage({ title: 'Article', date_published: '2024-05-02T10:01:08Z', date_updated: '2024-05-03T12:00:00+02:00',
    html_content: '<p>Private to the body renderer</p>', categories: ['moving'], related_articles: ['other'], sort_order: 5 });
  const type: ContentType = { id: 'articles', name: 'articles', label_singular: 'Article', label_plural: 'Articles',
    route_template: '/articles/{slug}', created_at: '', fields: [], schema_type: 'Article', schema_field_mode: 'mapped',
    schema_field_map: { title: 'headline', date_published: 'datePublished', date_updated: 'dateModified' } };
  expect(JSON.parse(buildContentPageSchema(page, type, site, 'https://example.test/articles/example/')!)).toEqual({
    '@context': 'https://schema.org', '@type': 'Article', url: 'https://example.test/articles/example/', headline: 'Article',
    datePublished: '2024-05-02T10:01:08Z', dateModified: '2024-05-03T12:00:00+02:00',
  });
  const missing = JSON.parse(buildContentPageSchema({ ...page, date_published: '', date_updated: 'invalid' }, type, site, 'https://example.test/')!);
  expect(missing).not.toHaveProperty('datePublished');
  expect(missing).not.toHaveProperty('dateModified');
});

describe('buildContentPageSchema product and software offers', () => {
  const type = (schema_type: string, schema_field_map?: Record<string, string>): ContentType => ({
    id: 'apps', name: 'apps', label_singular: 'App', label_plural: 'Apps', fields: [], route_template: '/apps/{slug}',
    created_at: '2024-01-01', schema_type, schema_field_map, schema_field_mode: 'mapped',
  });
  it('nests price and rating of a SoftwareApplication in Offer and AggregateRating', () => {
    const page = makePage({ id: 'app', title: 'Typeroll', summary: 'A CMS', os: 'Web', category: 'BusinessApplication', price: '0', currency: 'EUR', stars: 4.6, votes: 12 });
    const schema = JSON.parse(buildContentPageSchema(page, type('SoftwareApplication', {
      title: 'name', summary: 'description', os: 'operatingSystem', category: 'applicationCategory',
      price: 'price', currency: 'priceCurrency', stars: 'ratingValue', votes: 'ratingCount',
    }), site, 'https://x/apps/app/')!);
    expect(schema).toEqual({
      '@context': 'https://schema.org', '@type': 'SoftwareApplication', url: 'https://x/apps/app/',
      name: 'Typeroll', description: 'A CMS', operatingSystem: 'Web', applicationCategory: 'BusinessApplication',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', url: 'https://x/apps/app/' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, ratingCount: 12 },
    });
  });
  it('uses the built-in Product names, wraps a brand name and drops a rating without a count', () => {
    const page = makePage({ id: 'p', title: 'Chair', price: 120, price_currency: 'SEK', brand: 'Acme', rating: 5 });
    const schema = JSON.parse(buildContentPageSchema(page, { ...type('Product'), schema_field_mode: 'all' }, site, 'https://x/p/')!);
    expect(schema.offers).toEqual({ '@type': 'Offer', price: 120, priceCurrency: 'SEK', url: 'https://x/p/' });
    expect(schema.brand).toEqual({ '@type': 'Brand', name: 'Acme' });
    expect(schema.aggregateRating).toBeUndefined();
    expect(schema.price).toBeUndefined();
    expect(schema.ratingValue).toBeUndefined();
  });
  it('keeps an authored offers object and leaves other types flat', () => {
    const offers = { '@type': 'AggregateOffer', lowPrice: 1, highPrice: 9, priceCurrency: 'EUR' };
    const product = JSON.parse(buildContentPageSchema(makePage({ id: 'p', title: 'X', offers, price: 5 }), { ...type('Product', { title: 'name', offers: 'offers', price: 'price' }) }, site, 'https://x/p/')!);
    expect(product.offers).toEqual(offers);
    const event = JSON.parse(buildContentPageSchema(makePage({ id: 'e', title: 'Talk', price: 5 }), type('Event', { title: 'name', price: 'price' }), site, 'https://x/e/')!);
    expect(event.price).toBe(5);
  });
});
