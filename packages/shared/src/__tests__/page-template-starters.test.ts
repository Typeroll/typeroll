import { describe, it, expect } from 'vitest';
import { getPageTemplateStarter, inferStarterKind } from '../page-template-starters.js';

describe('getPageTemplateStarter', () => {
  it('returns a blog starter with item_title, item_image (featured_image), item_body', () => {
    const blocks = getPageTemplateStarter('blog');
    expect(blocks).toBeTruthy();
    const types = blocks!.map((b) => b.type);
    expect(types).toContain('template/page_title');
    expect(types).toContain('template/page_featured_image');
    expect(types).toContain('template_content_slot');

    // The image block binds to `featured_image` (the blog template's
    // field name) and the body binds to `body`.
    const img = blocks!.find((b) => b.type === 'template/page_featured_image')!;
    expect((img.data as { field?: string }).field).toBe('featured_image');
    const body = blocks!.find((b) => b.type === 'template_content_slot')!;
    expect((body.data as { field?: string }).field).toBe('body');
  });

  it('returns a team starter binding to photo and the shared page body', () => {
    const blocks = getPageTemplateStarter('team');
    expect(blocks).toBeTruthy();
    const img = blocks!.find((b) => b.type === 'template/page_featured_image')!;
    expect((img.data as { field?: string }).field).toBe('photo');
    const body = blocks!.find((b) => b.type === 'template_content_slot')!;
    expect(body.type).toBe('template_content_slot');
  });

  it('returns an events starter binding date to start_at', () => {
    const blocks = getPageTemplateStarter('events');
    const date = blocks!.find((b) => b.type === 'template/page_date')!;
    expect((date.data as { field?: string }).field).toBe('start_at');
  });

  it('returns a products starter with the shared page body', () => {
    const blocks = getPageTemplateStarter('products');
    const body = blocks!.find((b) => b.type === 'template_content_slot')!;
    expect(body.type).toBe('template_content_slot');
  });

  it('returns an article starter with breadcrumbs, body, and a server-rendered outline', () => {
    const blocks = getPageTemplateStarter('article')!;
    expect(blocks.map((block) => block.type)).toEqual([
      'template/page_breadcrumbs',
      'template/page_title',
      'template/page_date',
      'core/columns',
    ]);
    expect(blocks[3].slots?.[0]?.[0]).toMatchObject({
      type: 'template_content_slot',
      data: { field: 'body' },
    });
    expect(blocks[3].slots?.[1]?.[0]).toMatchObject({
      type: 'core/table_of_contents',
      data: { levels: 'h2-h3' },
    });
  });

  it('returns a checklist starter with an optional PDF CTA and explicit navigation fields', () => {
    const blocks = getPageTemplateStarter('checklist')!;
    expect(blocks.map((block) => block.type)).toContain('template/show_if');
    const conditional = blocks.find((block) => block.type === 'template/show_if')!;
    expect(conditional.data).toMatchObject({ condition: 'page.pdf_url' });
    expect(conditional.children?.[0]).toMatchObject({
      type: 'core/button',
      data: { href: '{{page.pdf_url}}' },
    });
    const navigation = blocks.find((block) => block.type === 'template/page_navigation')!;
    expect(navigation.data).toMatchObject({
      previous_url_field: 'prev_url',
      next_url_field: 'next_url',
    });
  });

  it('returns a minimal custom starter (title and body)', () => {
    const blocks = getPageTemplateStarter('custom');
    expect(blocks).toHaveLength(2);
    expect(blocks![0].type).toBe('template/page_title');
  });

  it('returns undefined for unknown kinds', () => {
    expect(getPageTemplateStarter(undefined)).toBeUndefined();
    expect(getPageTemplateStarter('not-a-kind' as never)).toBeUndefined();
  });

  it('block ids are stable across calls (deterministic)', () => {
    const a = getPageTemplateStarter('blog')!;
    const b = getPageTemplateStarter('blog')!;
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe('inferStarterKind', () => {
  it('detects a blog shape from editorial custom fields', () => {
    expect(inferStarterKind([
      { name: 'excerpt' }, { name: 'featured_image' },
    ])).toBe('blog');
  });

  it('detects a checklist shape from pdf_url before generic article fields', () => {
    expect(inferStarterKind([
      { name: 'title' }, { name: 'body' }, { name: 'date_published' }, { name: 'pdf_url' },
    ])).toBe('checklist');
  });

  it('detects a team shape from role + photo', () => {
    expect(inferStarterKind([
      { name: 'name' }, { name: 'role' }, { name: 'photo' }, { name: 'bio' },
    ])).toBe('team');
  });

  it('detects an events shape from start_at', () => {
    expect(inferStarterKind([
      { name: 'name' }, { name: 'start_at' }, { name: 'location' },
    ])).toBe('events');
  });

  it('detects a products shape from price + image', () => {
    expect(inferStarterKind([
      { name: 'name' }, { name: 'price' }, { name: 'image' },
    ])).toBe('products');
  });

  it('falls back to custom for unrecognised shapes', () => {
    expect(inferStarterKind([
      { name: 'foo' }, { name: 'bar' },
    ])).toBe('custom');
  });
});
