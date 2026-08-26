/**
 * Item-to-item references and the computed backlink index.
 *
 * The design decision under test: the forward direction is stored, the
 * reverse is derived. Storing both means every write maintains two documents
 * and eventually they disagree — invisibly, because nothing validates it.
 */
import { describe, it, expect } from 'vitest';
import type { CollectionDef, CollectionItem } from '../types.js';
import {
  backlinksFor,
  buildBacklinkIndex,
  expandItemRefs,
  refFields,
  refIds,
} from '../item-refs.js';

const articles: Pick<CollectionDef, 'name' | 'fields'> = {
  name: 'articles',
  fields: [
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'mentions', type: 'item_ref_list', label: 'Mentions', ref_collection: 'companies' },
    { name: 'sponsor', type: 'item_ref', label: 'Sponsor', ref_collection: 'companies' },
    // A ref field with no target is meaningless — must be ignored, not crash.
    { name: 'broken', type: 'item_ref', label: 'Broken' },
  ],
};
const companies: Pick<CollectionDef, 'name' | 'fields'> = {
  name: 'companies',
  fields: [{ name: 'title', type: 'text', label: 'Title' }],
};

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'published', created_at: 'x', updated_at: 'x', ...extra }) as CollectionItem;

describe('refFields', () => {
  it('finds both ref shapes and skips ones with no target collection', () => {
    const found = refFields(articles);
    expect(found.map((r) => r.field.name)).toEqual(['mentions', 'sponsor']);
    expect(found.find((r) => r.field.name === 'mentions')!.many).toBe(true);
    expect(found.find((r) => r.field.name === 'sponsor')!.many).toBe(false);
  });
});

describe('refIds', () => {
  it('normalises both stored shapes', () => {
    expect(refIds('c1')).toEqual(['c1']);
    expect(refIds(['c1', 'c2'])).toEqual(['c1', 'c2']);
  });

  it('tolerates the empty and the malformed', () => {
    expect(refIds('')).toEqual([]);
    expect(refIds(undefined)).toEqual([]);
    expect(refIds(null)).toEqual([]);
    expect(refIds([null, 'c1', 42, ''])).toEqual(['c1']);
  });
});

describe('buildBacklinkIndex', () => {
  const items = {
    articles: [
      item('a1', { mentions: ['c1', 'c2'], sponsor: 'c1' }),
      item('a2', { mentions: ['c2'] }),
      item('a3', {}),
    ],
    companies: [item('c1'), item('c2'), item('c3')],
  };
  const index = buildBacklinkIndex([articles, companies], items);

  it('groups referencing items under the item they point at', () => {
    expect(backlinksFor(index, 'companies', 'c2').map((b) => b.id).sort()).toEqual(['a1', 'a2']);
  });

  it('labels each backlink with the collection it came from', () => {
    // Without this the ids are unusable: a consumer can't tell which
    // collection to load them from, and two referencing collections produce
    // an indistinguishable mixture.
    expect(backlinksFor(index, 'companies', 'c2')[0]).toEqual({ collection: 'articles', id: 'a1' });
  });

  it('narrows to one referencing collection on request', () => {
    expect(backlinksFor(index, 'companies', 'c2', 'articles')).toHaveLength(2);
    expect(backlinksFor(index, 'companies', 'c2', 'nope')).toEqual([]);
  });

  it('counts an article once even when it references the same item twice', () => {
    // a1 points at c1 through both `mentions` and `sponsor`. Listing it twice
    // on c1's page would look like a bug to a visitor.
    expect(backlinksFor(index, 'companies', 'c1')).toEqual([{ collection: 'articles', id: 'a1' }]);
  });

  it('returns nothing for an item nobody references', () => {
    expect(backlinksFor(index, 'companies', 'c3')).toEqual([]);
  });

  it('returns nothing for an unknown collection or id', () => {
    expect(backlinksFor(index, 'nope', 'c1')).toEqual([]);
    expect(backlinksFor(index, 'companies', 'nope')).toEqual([]);
  });

  it('ignores collections that declare no ref fields', () => {
    expect(index.articles).toBeUndefined();
  });
});

describe('expandItemRefs', () => {
  const lookup = (coll: string, id: string) =>
    coll === 'companies' && id === 'c1' ? item('c1', { title: 'Acme' }) : undefined;

  it('replaces a single ref id with the referenced item', () => {
    const out = expandItemRefs(item('a1', { sponsor: 'c1' }), articles, lookup) as Record<string, unknown>;
    expect((out.sponsor as Record<string, unknown>).title).toBe('Acme');
  });

  it('keeps the raw id reachable as {field}_id', () => {
    const out = expandItemRefs(item('a1', { sponsor: 'c1' }), articles, lookup) as Record<string, unknown>;
    expect(out.sponsor_id).toBe('c1');
  });

  it('leaves a dangling ref as the raw id rather than blanking it', () => {
    // A stale id is debuggable; a silently empty field is not. And there is
    // deliberately no referential integrity — a directory ingests messy data.
    const out = expandItemRefs(item('a1', { sponsor: 'gone' }), articles, lookup) as Record<string, unknown>;
    expect(out.sponsor).toBe('gone');
  });

  it('does not expand list refs — iterating them is the repeater’s job', () => {
    const out = expandItemRefs(item('a1', { mentions: ['c1'] }), articles, lookup) as Record<string, unknown>;
    expect(out.mentions).toEqual(['c1']);
  });

  it('returns the item untouched when the collection has no single refs', () => {
    const it = item('c1');
    expect(expandItemRefs(it, companies, lookup)).toBe(it);
  });
});
