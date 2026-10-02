import { describe, it, expect } from 'vitest';
import { chatEditLink, chatActionEditLink } from '../../lib/chat-action-links';

describe('chatEditLink', () => {
  it('maps each changed item to its portal editor', () => {
    expect(chatEditLink('mysite', 'page', 'about')).toEqual({ href: '/app/sites/mysite/pages/about', link_label: 'Edit page' });
    expect(chatEditLink('mysite', 'block_type', 'counter')).toEqual({ href: '/app/sites/mysite/blocks?type=counter', link_label: 'Edit block type' });
    expect(chatEditLink('mysite', 'partial', 'header')).toEqual({ href: '/app/sites/mysite/partials/header', link_label: 'Edit global block' });
    expect(chatEditLink('mysite', 'template', 'blog-post')).toEqual({ href: '/app/sites/mysite/templates/blog-post', link_label: 'Edit template' });
  });

  it('encodes ids', () => {
    expect(chatEditLink('mysite', 'block_type', 'a&b').href).toBe('/app/sites/mysite/blocks?type=a%26b');
    expect(chatEditLink('mysite', 'page', 'x/y').href).toBe('/app/sites/mysite/pages/x%2Fy');
  });
});

describe('chatActionEditLink', () => {
  it('uses the server-computed href and label', () => {
    expect(chatActionEditLink({ type: 'update_settings', target: 'counter', href: '/app/sites/mysite/blocks?type=counter', link_label: 'Edit block type' }, 'mysite'))
      .toEqual({ href: '/app/sites/mysite/blocks?type=counter', link_label: 'Edit block type' });
  });

  it('falls back to the page editor only for page actions without href', () => {
    expect(chatActionEditLink({ type: 'update_page_seo', target: 'about' }, 'mysite')).toEqual({ href: '/app/sites/mysite/pages/about', link_label: 'Edit page' });
    expect(chatActionEditLink({ type: 'update_settings', target: 'counter' }, 'mysite')).toBeNull();
    expect(chatActionEditLink({ type: 'update_partial', target: 'header' }, 'mysite')).toBeNull();
    expect(chatActionEditLink({ type: 'update_page' }, 'mysite')).toBeNull();
  });

  it('never links outside the portal editor', () => {
    expect(chatActionEditLink({ type: 'update_page', target: 'x', href: 'https://evil.example/' }, 'mysite')).toBeNull();
    expect(chatActionEditLink({ type: 'update_page', target: 'x', href: 'javascript:alert(1)' }, 'mysite')).toBeNull();
  });
});
