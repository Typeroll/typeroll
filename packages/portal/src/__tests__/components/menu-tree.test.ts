// Tree operations behind the portal's menu editor: moves, indent/outdent
// within the three-level limit, add/remove, and mapping server validation
// paths back to items.

import { describe, expect, it } from 'vitest';
import { MAX_MENU_DEPTH, validateMenu, type MenuItem } from '@typeroll/shared';
import {
  addItem, canAddTo, canIndent, canMove, canOutdent, countItems, errorsByItem, findItem, hrefProblem,
  indentItem, itemForPath, moveItem, moveToIndex, nextItemId, normalizeLocation, outdentItem, removeItem,
  subtreeHeight, updateItem,
} from '../../components/menu-tree';

const page = (id: string, children?: MenuItem[]): MenuItem => ({ id, type: 'page', page_id: `p-${id}`, ...(children ? { children } : {}) });
const ids = (items: MenuItem[]): unknown => items.map((item) => (item.children?.length ? { [item.id]: ids(item.children) } : item.id));

// a, b(b1, b2(b2x)), c
const tree: MenuItem[] = [page('a'), page('b', [page('b1'), page('b2', [page('b2x')])]), page('c')];

describe('menu tree lookups', () => {
  it('finds an item with its parent, index and depth', () => {
    const at = findItem(tree, 'b2x')!;
    expect(at.parentId).toBe('b2');
    expect(at.depth).toBe(3);
    expect(findItem(tree, 'c')).toMatchObject({ parentId: null, index: 2, depth: 1 });
    expect(findItem(tree, 'missing')).toBeNull();
  });

  it('measures subtrees and counts items', () => {
    expect(subtreeHeight(tree[1]!)).toBe(3);
    expect(subtreeHeight(tree[0]!)).toBe(1);
    expect(countItems(tree)).toBe(6);
  });

  it('picks the next free item id', () => {
    expect(nextItemId([])).toBe('item-1');
    expect(nextItemId([{ id: 'item-1', type: 'heading', label: 'x', children: [{ id: 'item-2', type: 'heading', label: 'y' }] }])).toBe('item-3');
  });
});

describe('moving items', () => {
  it('moves among siblings only and leaves the input untouched', () => {
    expect(ids(moveItem(tree, 'c', -1))).toEqual(['a', 'c', { b: ['b1', { b2: ['b2x'] }] }]);
    expect(ids(moveItem(tree, 'b2', -1))).toEqual(['a', { b: [{ b2: ['b2x'] }, 'b1'] }, 'c']);
    expect(ids(tree)).toEqual(['a', { b: ['b1', { b2: ['b2x'] }] }, 'c']);
  });

  it('refuses moves past the ends of the list', () => {
    expect(canMove(tree, 'a', -1)).toBe(false);
    expect(canMove(tree, 'c', 1)).toBe(false);
    expect(canMove(tree, 'b1', 1)).toBe(true);
    expect(moveItem(tree, 'a', -1)).toBe(tree);
  });

  it('moves to an index for drag and drop', () => {
    expect(ids(moveToIndex(tree, 'a', 2))).toEqual([{ b: ['b1', { b2: ['b2x'] }] }, 'c', 'a']);
    expect(moveToIndex(tree, 'a', 5)).toBe(tree);
  });
});

describe('indent and outdent', () => {
  it('indents under the sibling above', () => {
    expect(ids(indentItem(tree, 'c'))).toEqual(['a', { b: ['b1', { b2: ['b2x'] }, 'c'] }]);
    expect(ids(indentItem(tree, 'b1'))).toEqual(ids(tree)); // first child: nothing above
    expect(ids(indentItem([page('x'), page('y')], 'y'))).toEqual([{ x: ['y'] }]);
  });

  it(`never makes a menu deeper than ${MAX_MENU_DEPTH} levels`, () => {
    // b2 has a child: under b1 it would reach level 4.
    expect(canIndent(tree, 'b2')).toBe(false);
    expect(indentItem(tree, 'b2')).toBe(tree);
    // b with two levels below cannot go under a.
    expect(canIndent(tree, 'b')).toBe(false);
    // The first item has no sibling above.
    expect(canIndent(tree, 'a')).toBe(false);
    const flat = [page('x'), page('y', [page('y1')])];
    expect(canIndent(flat, 'y')).toBe(true);
    expect(ids(indentItem(flat, 'y'))).toEqual([{ x: [{ y: ['y1'] }] }]);
  });

  it('does not indent under a page-children item', () => {
    const items: MenuItem[] = [{ id: 'kids', type: 'children', page_id: 'p' }, page('z')];
    expect(canIndent(items, 'z')).toBe(false);
    expect(canAddTo(items, 'kids')).toBe(false);
  });

  it('outdents to right after the parent', () => {
    expect(canOutdent(tree, 'a')).toBe(false);
    expect(ids(outdentItem(tree, 'b1'))).toEqual(['a', { b: [{ b2: ['b2x'] }] }, 'b1', 'c']);
    expect(ids(outdentItem(tree, 'b2x'))).toEqual(['a', { b: ['b1', 'b2', 'b2x'] }, 'c']);
  });

  it('drops an emptied children list', () => {
    const items = [page('p', [page('only')])];
    const out = outdentItem(items, 'only');
    expect(out[0]).not.toHaveProperty('children');
    expect(ids(out)).toEqual(['p', 'only']);
  });
});

describe('add, update and remove', () => {
  it('adds at the top level or under an item that may hold children', () => {
    expect(ids(addItem(tree, page('d')))).toEqual(['a', { b: ['b1', { b2: ['b2x'] }] }, 'c', 'd']);
    expect(ids(addItem(tree, page('a1'), 'a'))).toEqual([{ a: ['a1'] }, { b: ['b1', { b2: ['b2x'] }] }, 'c']);
    // b2x is on the third level: nothing goes below it.
    expect(canAddTo(tree, 'b2x')).toBe(false);
    expect(addItem(tree, page('deep'), 'b2x')).toBe(tree);
  });

  it('removes an item with its children', () => {
    expect(ids(removeItem(tree, 'b2'))).toEqual(['a', { b: ['b1'] }, 'c']);
    expect(countItems(removeItem(tree, 'b'))).toBe(2);
  });

  it('updates fields and drops emptied ones', () => {
    const out = updateItem(tree, 'b1', { label: 'Team', description: '' });
    expect(findItem(out, 'b1')!.item).toEqual({ id: 'b1', type: 'page', page_id: 'p-b1', label: 'Team' });
    const cleared = updateItem(out, 'b1', { label: '' });
    expect(findItem(cleared, 'b1')!.item).not.toHaveProperty('label');
  });
});

describe('validation helpers', () => {
  it('maps server paths to items', () => {
    expect(itemForPath(tree, 'items[1].children[1].children[0].label')).toEqual({ id: 'b2x', field: 'label' });
    expect(itemForPath(tree, 'items[2]')).toEqual({ id: 'c', field: null });
    expect(itemForPath(tree, 'name')).toBeNull();
    expect(itemForPath(tree, 'items[9].label')).toBeNull();
  });

  it('groups validateMenu errors by item', () => {
    const items: MenuItem[] = [{ id: 'link', type: 'url', href: 'javascript:alert(1)' }];
    const { errors } = validateMenu({ id: 'main', name: '', items });
    const grouped = errorsByItem(items, errors);
    expect(grouped.get('link')).toEqual(['Address: This kind of address is not allowed', 'Label: Give the link a label']);
    expect(grouped.get('')?.[0]).toMatch(/^name: /);
  });

  it('refuses script addresses like the server does', () => {
    expect(hrefProblem('javascript:alert(1)')).toMatch(/not allowed/);
    expect(hrefProblem(' JavaScript:void(0)')).toMatch(/not allowed/);
    expect(hrefProblem('data:text/html,x')).toMatch(/not allowed/);
    expect(hrefProblem('')).toMatch(/Give the address/);
    expect(hrefProblem('https://example.com')).toBeNull();
    expect(hrefProblem('/contact#form')).toBeNull();
  });

  it('turns a typed location into a stored one', () => {
    expect(normalizeLocation('Side bar')).toBe('side-bar');
    expect(normalizeLocation('  Footer 2 ')).toBe('footer-2');
    expect(normalizeLocation('2nd')).toBe('nd');
    expect(normalizeLocation('Språk')).toBe('sprak');
  });
});
