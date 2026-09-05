import { describe, it, expect } from 'vitest';
import { getCollectionStarter, inferStarterKind } from '../collection-starters.js';

describe('getCollectionStarter', () => {
  it('returns a blog starter with item_title, item_image (featured_image), item_body', () => {
    const blocks = getCollectionStarter('blog');
    expect(blocks).toBeTruthy();
    const types = blocks!.map((b) => b.type);
    expect(types).toContain('template/item_title');
    expect(types).toContain('template/item_image');
    expect(types).toContain('template/item_body');

    // The image block binds to `featured_image` (the blog template's
    // field name) and the body binds to `body`.
    const img = blocks!.find((b) => b.type === 'template/item_image')!;
    expect((img.data as { field?: string }).field).toBe('featured_image');
    const body = blocks!.find((b) => b.type === 'template/item_body')!;
    expect((body.data as { field?: string }).field).toBe('body');
  });

  it('returns a team starter binding to photo + bio', () => {
    const blocks = getCollectionStarter('team');
    expect(blocks).toBeTruthy();
    const img = blocks!.find((b) => b.type === 'template/item_image')!;
    expect((img.data as { field?: string }).field).toBe('photo');
    const body = blocks!.find((b) => b.type === 'template/item_body')!;
    expect((body.data as { field?: string }).field).toBe('bio');
  });

  it('returns an events starter binding date to start_at', () => {
    const blocks = getCollectionStarter('events');
    const date = blocks!.find((b) => b.type === 'template/page_date')!;
    expect((date.data as { field?: string }).field).toBe('start_at');
  });

  it('returns a products starter binding body to description', () => {
    const blocks = getCollectionStarter('products');
    const body = blocks!.find((b) => b.type === 'template/item_body')!;
    expect((body.data as { field?: string }).field).toBe('description');
  });

  it('returns an article starter with breadcrumbs, body, and a server-rendered outline', () => {
    const blocks = getCollectionStarter('article')!;
    expect(blocks.map((block) => block.type)).toEqual([
      'template/page_breadcrumbs',
      'template/item_title',
      'template/page_date',
      'core/columns',
    ]);
    expect(blocks[3].slots?.[0]?.[0]).toMatchObject({
      type: 'template/item_body',
      data: { field: 'body' },
    });
    expect(blocks[3].slots?.[1]?.[0]).toMatchObject({
      type: 'core/table_of_contents',
      data: { source_field: 'body' },
    });
  });

  it('returns a checklist starter with an optional PDF CTA and explicit navigation fields', () => {
    const blocks = getCollectionStarter('checklist')!;
    expect(blocks.map((block) => block.type)).toContain('template/show_if');
    const conditional = blocks.find((block) => block.type === 'template/show_if')!;
    expect(conditional.data).toMatchObject({ condition: 'item.pdf_url' });
    expect(conditional.children?.[0]).toMatchObject({
      type: 'core/button',
      data: { href: '{{item.pdf_url}}' },
    });
    const navigation = blocks.find((block) => block.type === 'template/item_navigation')!;
    expect(navigation.data).toMatchObject({
      previous_url_field: 'prev_url',
      next_url_field: 'next_url',
    });
  });

  it('returns a minimal custom starter (just item_title)', () => {
    const blocks = getCollectionStarter('custom');
    expect(blocks).toHaveLength(1);
    expect(blocks![0].type).toBe('template/item_title');
  });

  it('returns undefined for unknown kinds', () => {
    expect(getCollectionStarter(undefined)).toBeUndefined();
    expect(getCollectionStarter('not-a-kind' as never)).toBeUndefined();
  });

  it('block ids are stable across calls (deterministic)', () => {
    const a = getCollectionStarter('blog')!;
    const b = getCollectionStarter('blog')!;
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe('inferStarterKind', () => {
  it('detects a blog shape from body + published_at', () => {
    expect(inferStarterKind([
      { name: 'title' }, { name: 'body' }, { name: 'published_at' },
    ])).toBe('blog');
  });

  it('detects a checklist shape from pdf_url before generic article fields', () => {
    expect(inferStarterKind([
      { name: 'title' }, { name: 'body' }, { name: 'published_at' }, { name: 'pdf_url' },
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
