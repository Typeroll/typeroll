import { describe, expect, it } from 'vitest';
import {
  buildCoreBlockRegistry, collectBlockAssets, createPageSource, menuPagesFromSource, renderBlocks, submenuDisplay, usesMenuSubmenus,
  type Block, type Menu, type MenuSource, type Page,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const menu: Menu = {
  id: 'main', name: 'Main', locations: ['primary'], items: [
    { id: 'about', type: 'page', page_id: 'about' },
    { id: 'services', type: 'page', page_id: 'services', children: [
      { id: 'design', type: 'page', page_id: 'design' },
      { id: 'blog', type: 'url', href: 'https://blog.example.com/', label: 'Blog "news" <b>', link_rel: 'nofollow' },
    ] },
  ],
};
const pages = () => [
  { id: 'about', title: 'About us', path: '/about/' },
  { id: 'services', title: 'Services', path: '/services/' },
  { id: 'design', title: 'Design & build', path: '/services/design/', parent: 'services' },
];
const block = (data: Record<string, unknown>): Block => ({ id: 'nav', type: 'core/navigation_links', data: { source: 'menu', menu: 'location:primary', direction: 'row', ...data } });
const render = (data: Record<string, unknown>, options: { renderVersion?: number; path?: string; language?: string; menuSource?: MenuSource } = {}) =>
  renderBlocks([block(data)], {
    registry, renderVersion: options.renderVersion ?? 15,
    menuSource: options.menuSource ?? { menus: [menu], pages },
    context: { page: { path: options.path ?? '/', language: options.language } },
  });

describe('navigation links from a site menu', () => {
  it('keeps render version 14 on the block\'s own links', () => {
    const html = render({ links: [{ label: 'Contact', href: '/contact/' }] }, { renderVersion: 14 });
    expect(html).toContain('<a href="/contact/">Contact</a>');
    expect(html).not.toContain('About us');
    expect(html).not.toContain('data-block-type');
    expect(collectBlockAssets([block({})], registry, { renderVersion: 14 }).js).toBe('');
  });

  it('renders the menu with a submenu, the current page and its parent at version 15', () => {
    const html = render({}, { path: '/services/design/' });
    expect(html).toContain('data-block-type="core/navigation_links"');
    expect(html).toContain('<li><a href="/about/">About us</a></li>');
    expect(html).toContain('<li class="block-nav-parent block-nav-parent--current" data-submenu="dropdown"><a href="/services/">Services</a>');
    expect(html).toContain('aria-controls="nav-nav-services"');
    expect(html).toContain('<ul class="block-nav-sub" id="nav-nav-services">');
    expect(html).toContain('<a href="/services/design/" aria-current="page">Design &amp; build</a>');
    expect(html).toContain('<span class="block-nav-sr">Show submenu: Services</span>');
  });

  it('escapes labels and keeps link relationships', () => {
    const html = render({});
    expect(html).toContain('<a href="https://blog.example.com/" rel="nofollow">Blog &quot;news&quot; &lt;b&gt;</a>');
    expect(html).not.toContain('<b>');
  });

  it('labels the submenu button in the page language', () => {
    expect(render({}, { language: 'sv' })).toContain('Visa undermeny: Services');
  });

  it('opens submenus as an accordion in a column and as configured otherwise', () => {
    expect(render({ direction: 'column' })).toContain('data-submenu="accordion"');
    expect(submenuDisplay('auto', { mobile: 'column', tablet: 'row' })).toBe('dropdown');
    expect(submenuDisplay(undefined, undefined)).toBe('accordion');
    const expanded = render({ submenus: 'expanded' });
    expect(expanded).not.toContain('block-nav-toggle');
    expect(expanded).toContain('<li class="block-nav-parent"><a href="/services/">Services</a><ul class="block-nav-sub"');
    const none = render({ submenus: 'none' });
    expect(none).not.toContain('block-nav-sub');
    expect(none).not.toContain('data-block-type');
  });

  it('renders an empty list and reports a menu that does not exist', () => {
    const warnings: string[] = [];
    const html = render({ menu: 'location:footer' }, { menuSource: { menus: [menu], pages, onWarning: message => warnings.push(message) } });
    expect(html).toMatch(/<ul data-block="navigation_links"[^>]*><\/ul>/);
    expect(warnings).toEqual(['A Navigation links block (nav) shows the menu "location:footer", which does not exist; it renders no links.']);
    expect(renderBlocks([block({})], { registry, renderVersion: 15 })).toMatch(/<ul data-block="navigation_links"[^>]*><\/ul>/);
  });

  it('reports menu items whose page is gone', () => {
    const warnings: string[] = [];
    render({}, { menuSource: { menus: [menu], pages: () => pages().filter(page => page.id !== 'about'), onWarning: message => warnings.push(message) } });
    expect(warnings).toEqual(['Menu "Main": item about links to a page that is missing or not published; it is left out.']);
  });

  it('follows page titles and addresses from the page source', () => {
    const records = [
      { id: 'about', title: 'Who we are', slug: 'who', path: '/who/', status: 'published', content_mode: 'blocks', blocks: [] },
      { id: 'services', title: 'Services', slug: 'services', path: '/services/', status: 'draft', content_mode: 'blocks', blocks: [] },
    ] as unknown as Page[];
    const pageSource = createPageSource([], records, 'always');
    expect(menuPagesFromSource(pageSource)).toEqual([{ id: 'about', title: 'Who we are', path: '/who/', parent: null, sort_order: null, breadcrumb_label: null, status: 'published' }]);
    const html = renderBlocks([block({})], { registry, renderVersion: 15, pageSource, menuSource: { menus: [menu] }, context: { page: { path: '/who/' } } });
    expect(html).toContain('<a href="/who/" aria-current="page">Who we are</a>');
    expect(html).not.toContain('Services');
  });

  it('ships the submenu script only with a menu that has submenus', () => {
    const js = (data: Record<string, unknown>, renderVersion = 15) => collectBlockAssets([{ id: 'section', type: 'core/section', data: {}, children: [block(data)] }], registry, { renderVersion }).js;
    expect(js({})).toContain("register('core/navigation_links'");
    expect(js({ source: 'links' })).toBe('');
    expect(js({ submenus: 'expanded' })).toBe('');
    expect(js({}, 14)).toBe('');
    expect(usesMenuSubmenus([{ id: 'menu', type: 'core/navigation_menu', data: {}, slots: [[block({})], []] }])).toBe(true);
    const css = collectBlockAssets([block({})], registry, { renderVersion: 15 }).css;
    expect(css).toContain('[data-submenu="dropdown"] > .block-nav-sub');
    expect(css).toContain('prefers-reduced-motion');
    expect(css.split('/* core/navigation_links */')[1]?.split('/* ')[0]).not.toContain('!important');
  });
});
