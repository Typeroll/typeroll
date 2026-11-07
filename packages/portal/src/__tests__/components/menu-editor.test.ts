// Server render of the portal menu editor and its save helpers. The tree
// operations themselves are covered in menu-tree.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Menu } from '@typeroll/shared';
import MenuEditor, { conflictKind, menuSaveBody, type MenuEditorPage } from '../../components/MenuEditor';

const pages: MenuEditorPage[] = [
  { id: 'about', title: 'About us', path: '/about/', parent: null, status: 'published' },
  { id: 'team', title: 'Team', path: '/about/team/', parent: 'about', status: 'published' },
  { id: 'draft', title: 'Coming soon', path: '/soon/', parent: null, status: 'draft' },
];

const menu: Menu = {
  id: 'main', name: 'Main', locations: ['primary'], updated_at: '2026-11-01T10:00:00.000Z',
  items: [
    { id: 'item-1', type: 'page', page_id: 'about', children: [{ id: 'item-2', type: 'children', page_id: 'about' }] },
    { id: 'item-3', type: 'url', label: 'Shop', href: 'https://shop.example' },
    { id: 'item-4', type: 'page', page_id: 'draft' },
  ],
};

const render = (canEdit = true) => renderToString(createElement(MenuEditor, {
  siteId: 'site', menu, pages, takenLocations: { footer: 'Footer links' }, canEdit,
}));

describe('MenuEditor', () => {
  it('shows each item with the page title, its type and level controls', () => {
    const html = render();
    expect(html).toContain('About us');
    expect(html).toContain('Children of About us');
    expect(html).toContain('Shop');
    expect(html).toContain("Page&#x27;s children");
    expect(html).toContain('draft: hidden until published');
    // The first item cannot move up or out; the nested one cannot go deeper under nothing.
    expect(html).toMatch(/<button[^>]*aria-label="Move About us up"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Move About us out one level"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Move Shop under the item above"[^>]*disabled=""/);
  });

  it('marks a location another menu fills and explains how to show the menu', () => {
    const html = render();
    expect(html).toContain('Filled by “Footer links”');
    expect(html).toContain('location:primary');
    expect(html).toContain('Navigation links');
  });

  it('previews only what visitors get', () => {
    const html = render();
    const preview = html.slice(html.indexOf('menu-editor__preview'));
    expect(preview).toContain('Team');
    expect(preview).not.toContain('Coming soon');
  });

  it('keeps its stylesheet as raw text so hydration matches', () => {
    const css = [...render().matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).find((text) => text!.includes('.menu-editor__row'));
    expect(css).toContain('[aria-expanded="true"]');
    expect(css).not.toMatch(/&(?:gt|lt|quot|amp);/);
  });

  it('is read-only without write access', () => {
    const html = render(false);
    expect(html).not.toContain('Save menu');
    expect(html).not.toContain('Add items');
    expect(html).not.toContain('Delete this menu');
  });
});

describe('menu save helpers', () => {
  it('sends the whole menu with the updated_at it was read at', () => {
    expect(menuSaveBody({ name: ' Main ', locations: ['primary'], auto_add_pages: true, items: [] }, 'T1')).toEqual({
      name: 'Main', locations: ['primary'], auto_add_pages: true, items: [], expected_updated_at: 'T1',
    });
  });

  it('tells a stale save from a taken location', () => {
    expect(conflictKind('The menu was saved by someone else after you read it. Read it again and reapply your change.')).toBe('stale');
    expect(conflictKind('The location "primary" is already filled by the menu "Other" (other). Remove it from that menu first; a location shows one menu.')).toBe('location');
  });
});

describe('menu pages', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const portal = path.resolve(here, '../..');

  it('links Menus from the site sidebar', () => {
    const layout = fs.readFileSync(path.join(portal, 'layouts/AppLayout.astro'), 'utf8');
    expect(layout).toContain('href={`/app/sites/${siteId}/menus`}');
  });

  it('creates menus through the form route and opens them in the editor', () => {
    const list = fs.readFileSync(path.join(portal, 'pages/app/sites/[siteId]/menus/index.astro'), 'utf8');
    expect(list).toContain('action={`/api/sites/${siteId}/menus/create`}');
    expect(list).toContain('href={`/app/sites/${siteId}/menus/${menu.id}`}');
    const editor = fs.readFileSync(path.join(portal, 'pages/app/sites/[siteId]/menus/[menuId].astro'), 'utf8');
    expect(editor).toContain('<MenuEditor client:load');
  });
});
