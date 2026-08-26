/**
 * The "what's missing" read.
 *
 * Modelled on analyzeCoverage() from the migration workflow, including the
 * part that matters: status is computed at read time, never stored. A
 * persisted completeness score is wrong the moment anyone edits an item and
 * nothing tells you it went stale.
 */
import { describe, it, expect } from 'vitest';
import type { CollectionDef, CollectionItem } from '@typeroll/shared';
import { PROVENANCE_KEY } from '../../lib/field-authority';
import { analyzeCompleteness } from '../../lib/collection-completeness';

const coll: Pick<CollectionDef, 'name' | 'fields'> = {
  name: 'companies',
  fields: [
    { name: 'title', type: 'text', label: 'Name', required: true },
    { name: 'description', type: 'textarea', label: 'Description' },
    { name: 'phone', type: 'text', label: 'Phone' },
    // Only the app may write this — an agent can never close a gap here, so
    // reporting it as a gap would be noise it can't clear.
    { name: 'plan', type: 'text', label: 'Plan', writable_by: ['app'] },
  ],
};

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'published', created_at: 'x', updated_at: 'x', ...extra }) as CollectionItem;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('analyzeCompleteness', () => {
  it('counts a missing required field as incomplete', () => {
    const r = analyzeCompleteness(coll, [item('1', { description: 'x', phone: '1' })]);
    expect(r.incomplete_items).toBe(1);
    expect(r.items[0].missing.map((m) => m.field)).toEqual(['title']);
    expect(r.items[0].missing[0].required).toBe(true);
  });

  it('excludes fields no agent may write', () => {
    // `plan` is empty on every item but agent-unwritable, so it must not
    // appear as a gap in the default (worklist) mode.
    const r = analyzeCompleteness(coll, [item('1', { title: 'A', description: 'd', phone: 'p' })]);
    expect(r.items[0].missing).toEqual([]);
    expect(r.field_gaps.map((g) => g.field)).not.toContain('plan');
    expect(r.items[0].score).toBe(1);
  });

  it('includes them for a human audit when asked', () => {
    const r = analyzeCompleteness(
      coll, [item('1', { title: 'A', description: 'd', phone: 'p' })],
      { agent_writable_only: false },
    );
    expect(r.items[0].missing.map((m) => m.field)).toEqual(['plan']);
  });

  it('treats empty strings, arrays and objects as missing', () => {
    const r = analyzeCompleteness(coll, [item('1', { title: '', description: [], phone: {} })]);
    expect(r.items[0].missing.map((m) => m.field).sort()).toEqual(['description', 'phone', 'title']);
  });

  it('scores 0–1 over the fields an agent could fill', () => {
    const r = analyzeCompleteness(coll, [item('1', { title: 'A' })]);
    // 3 scorable fields, 1 filled.
    expect(r.items[0].score).toBeCloseTo(1 / 3);
  });

  it('ranks worst first — required gaps, then total gaps', () => {
    const r = analyzeCompleteness(coll, [
      item('good', { title: 'A', description: 'd', phone: 'p' }),
      item('two-gaps', { title: 'A' }),
      item('no-title', { description: 'd', phone: 'p' }),
    ]);
    // no-title is missing a REQUIRED field, so it outranks two-gaps even
    // though two-gaps has more gaps overall.
    expect(r.items.map((i) => i.id)).toEqual(['no-title', 'two-gaps', 'good']);
  });

  it('reports per-field gap counts so a systematically empty column is visible', () => {
    const r = analyzeCompleteness(coll, [
      item('1', { title: 'A' }), item('2', { title: 'B' }), item('3', { title: 'C', phone: 'p' }),
    ]);
    const byField = Object.fromEntries(r.field_gaps.map((g) => [g.field, g.missing_count]));
    expect(byField.description).toBe(3);
    expect(byField.phone).toBe(2);
    expect(byField.title).toBe(0);
  });

  it('flags a filled field with no provenance as unverified', () => {
    const r = analyzeCompleteness(coll, [item('1', { title: 'A', description: 'd', phone: 'p' })]);
    expect(r.items[0].unverified.sort()).toEqual(['description', 'phone', 'title']);
  });

  it('does not call an EMPTY field unverified or stale', () => {
    // Those describe values that exist but may no longer be true; an empty
    // field is already reported as missing and shouldn't be double-counted.
    const r = analyzeCompleteness(coll, [item('1', {})]);
    expect(r.items[0].unverified).toEqual([]);
    expect(r.items[0].stale).toEqual([]);
  });

  it('flags a field whose last write is older than the window', () => {
    const r = analyzeCompleteness(coll, [
      item('1', {
        title: 'A', description: 'd', phone: 'p',
        [PROVENANCE_KEY]: {
          title: { source: 'agent', actor: 'a', updated_at: daysAgo(400) },
          description: { source: 'owner', actor: 'b', updated_at: daysAgo(10) },
        },
      }),
    ]);
    expect(r.items[0].stale.map((s) => s.field)).toEqual(['title']);
    expect(r.items[0].stale[0].source).toBe('agent');
  });

  it('honours a custom staleness window', () => {
    const withProv = item('1', {
      title: 'A', description: 'd', phone: 'p',
      [PROVENANCE_KEY]: { title: { source: 'agent', actor: 'a', updated_at: daysAgo(30) } },
    });
    expect(analyzeCompleteness(coll, [withProv]).items[0].stale).toEqual([]);
    expect(analyzeCompleteness(coll, [withProv], { stale_after_days: 7 }).items[0].stale).toHaveLength(1);
  });

  it('reports how many items it left out rather than silently truncating', () => {
    // A truncated list that reads like a full one is how "we covered
    // everything" quietly becomes false.
    const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`));
    const r = analyzeCompleteness(coll, items, { limit: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.total_items).toBe(10);
    expect(r.truncated).toBe(7);
  });

  it('handles an empty collection without dividing by zero', () => {
    const r = analyzeCompleteness(coll, []);
    expect(r.total_items).toBe(0);
    expect(r.average_score).toBe(1);
    expect(r.truncated).toBe(0);
  });

  it('labels items by the first human-ish field it can find', () => {
    expect(analyzeCompleteness(coll, [item('x', { title: 'Acme' })]).items[0].title).toBe('Acme');
    expect(analyzeCompleteness(coll, [item('x', { name: 'Beta' })]).items[0].title).toBe('Beta');
    expect(analyzeCompleteness(coll, [item('x')]).items[0].title).toBe('x');
  });
});
