import { describe, expect, it } from 'vitest';
import { findMenu, locationConflicts, renderMenuItems, resolveMenu, validateMenu, type Menu, type MenuPage } from '../menus.js';

const pages: MenuPage[] = [
  { id: 'home', title: 'Home', path: '/', status: 'published' },
  { id: 'services', title: 'Our services', path: '/services', status: 'published', sort_order: 1, breadcrumb_label: 'Services' },
  { id: 'design', title: 'Design', path: '/services/design', parent: 'services', status: 'published', sort_order: 2 },
  { id: 'build', title: 'Build', path: '/services/build', parent: 'services', status: 'published', sort_order: 1 },
  { id: 'secret', title: 'Secret', path: '/services/secret', parent: 'services', status: 'draft' },
  { id: 'about', title: 'About us', path: '/about', status: 'published', sort_order: 2 },
  { id: 'contact', title: 'Contact', path: '/contact', status: 'published', sort_order: 3 },
];

const menu: Menu = {
  id: 'main', name: 'Main menu', locations: ['primary'],
  items: [
    { id: 'home', type: 'page', page_id: 'home' },
    { id: 'services', type: 'page', page_id: 'services', children: [{ id: 'list', type: 'children', page_id: 'services' }] },
    { id: 'blog', type: 'url', href: 'https://blog.example.com', label: 'Blog' },
    { id: 'gone', type: 'page', page_id: 'deleted-page' },
  ],
};

describe('validateMenu', () => {
  it('accepts a well-formed menu and drops unknown fields', () => {
    const { menu: valid, errors } = validateMenu({ ...menu, extra: 1 });
    expect(errors).toEqual([]);
    expect(valid).toMatchObject({ id: 'main', locations: ['primary'] });
    expect(valid).not.toHaveProperty('extra');
  });

  it('reports each problem with its path', () => {
    const { menu: invalid, errors } = validateMenu({
      id: 'Main Menu', name: '', locations: ['primary', 'primary'],
      items: [
        { id: 'a', type: 'url', href: 'javascript:alert(1)' },
        { id: 'a', type: 'page' },
        { id: 'c', type: 'children', page_id: 'x', children: [{ id: 'd', type: 'heading', label: 'D' }] },
        { id: 'e', type: 'heading', label: 'E', children: [{ id: 'f', type: 'heading', label: 'F', children: [{ id: 'g', type: 'heading', label: 'G', children: [{ id: 'h', type: 'heading', label: 'H' }] }] }] },
      ],
    });
    expect(invalid).toBeNull();
    const paths = errors.map((error) => error.path);
    expect(paths).toEqual(expect.arrayContaining(['id', 'name', 'locations', 'items[0].href', 'items[0].label', 'items[1].id', 'items[1].page_id', 'items[2].children', 'items[3].children[0].children[0].children']));
  });

  it('finds menus by id or location and reports shared locations', () => {
    const footer: Menu = { id: 'footer', name: 'Footer', locations: ['footer', 'primary'], items: [] };
    expect(findMenu([menu, footer], 'location:primary')?.id).toBe('main');
    expect(findMenu([menu, footer], 'footer')?.id).toBe('footer');
    expect(findMenu([menu], 'location:mobile')).toBeUndefined();
    expect(locationConflicts([menu, footer])).toEqual(['primary']);
  });
});

describe('resolveMenu', () => {
  it('takes page titles and addresses at build time and lists published children in order', () => {
    const { items, warnings } = resolveMenu(menu, pages, '/services/design/');
    expect(items.map((item) => [item.label, item.href])).toEqual([['Home', '/'], ['Services', '/services'], ['Blog', 'https://blog.example.com']]);
    expect(items[1]!.children.map((item) => item.label)).toEqual(['Build', 'Design']);
    expect(items[1]!.current_ancestor).toBe(true);
    expect(items[1]!.children[1]!.current).toBe(true);
    expect(items[0]!.current).toBe(false);
    expect(warnings.join(' ')).toMatch(/item gone links to a page that is missing/);
  });

  it('follows a renamed page and an overridden label', () => {
    const renamed = pages.map((page) => (page.id === 'home' ? { ...page, title: 'Start', path: '/' } : page));
    const custom: Menu = { ...menu, items: [{ id: 'home', type: 'page', page_id: 'home' }, { id: 'about', type: 'page', page_id: 'about', label: 'Who we are' }] };
    expect(resolveMenu(custom, renamed, '/about').items.map((item) => [item.label, item.current])).toEqual([['Start', false], ['Who we are', true]]);
  });

  it('adds new top-level pages automatically when asked', () => {
    const auto: Menu = { ...menu, auto_add_pages: true, items: [{ id: 'services', type: 'page', page_id: 'services' }] };
    expect(resolveMenu(auto, pages, '/').items.map((item) => item.label)).toEqual(['Services', 'About us', 'Contact']);
  });
});

describe('renderMenuItems', () => {
  const options = { idPrefix: 'nav-b1', display: 'dropdown' as const, withIcons: false, renderIcon: () => '', linkAttributes: () => '', toggleLabel: (label: string) => `Show the submenu: ${label}` };

  it('renders a disclosure button for each submenu', () => {
    const { items } = resolveMenu(menu, pages, '/services/build');
    const html = renderMenuItems(items, options);
    expect(html).toContain('<li class="block-nav-parent block-nav-parent--current" data-submenu="dropdown"><a href="/services">Services</a><button type="button" class="block-nav-toggle" aria-expanded="false" aria-controls="nav-b1-services"><span class="block-nav-sr">Show the submenu: Services</span></button><ul class="block-nav-sub" id="nav-b1-services">');
    expect(html).toContain('<a href="/services/build" aria-current="page">Build</a>');
  });

  it('lays out a submenu with groups in columns and opens a heading with its label', () => {
    const mega: Menu = { id: 'm', name: 'M', items: [{ id: 'all', type: 'heading', label: 'Everything', children: [
      { id: 'g1', type: 'heading', label: 'Work', children: [{ id: 'x', type: 'page', page_id: 'design', description: 'Brand and web' }] },
    ] }] };
    const html = renderMenuItems(resolveMenu(mega, pages, '/').items, options);
    expect(html).toContain('<button type="button" class="block-nav-toggle block-nav-toggle--label" aria-expanded="false" aria-controls="nav-b1-all">Everything</button>');
    expect(html).toContain('class="block-nav-sub block-nav-sub--columns"');
    expect(html).toContain('<span class="block-nav-description">Brand and web</span>');
  });

  it('shows children as a plain nested list when expanded, and leaves them out when hidden', () => {
    const { items } = resolveMenu(menu, pages, '/');
    expect(renderMenuItems(items, { ...options, display: 'expanded' })).not.toContain('<button');
    expect(renderMenuItems(items, { ...options, display: 'none' })).not.toContain('block-nav-sub');
  });

  it('escapes labels and addresses', () => {
    const evil: Menu = { id: 'e', name: 'E', items: [{ id: 'x', type: 'url', href: '/a"b', label: '<b>x</b>' }] };
    expect(renderMenuItems(resolveMenu(evil, pages, '/').items, options)).toBe('<li><a href="/a&quot;b">&lt;b&gt;x&lt;/b&gt;</a></li>');
  });
});
