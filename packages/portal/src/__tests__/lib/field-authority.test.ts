/**
 * Per-field write authority + provenance.
 *
 * The failure this prevents: a business corrects its own description through
 * an edit link on Monday, a scraper restores the stale one on Tuesday, and
 * nobody notices until a customer complains. Two mechanisms, kept separate —
 * `writable_by` decides who may write a field at all, provenance decides who
 * wins when two surfaces both may.
 */
import { describe, it, expect } from 'vitest';
import type { CollectionItem, FieldDefinition } from '@typeroll/shared';
import {
  DEFAULT_WRITABLE_BY,
  PROVENANCE_KEY,
  applyFieldAuthority,
  conflictResponse,
  isRenderedField,
  readProvenance,
  stampProvenance,
  writableBy,
} from '../../lib/field-authority';

const f = (name: string, extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ name, type: 'text', label: name, ...extra }) as FieldDefinition;

const FIELDS: FieldDefinition[] = [
  f('description'),                                    // default: portal + agent
  f('phone', { writable_by: ['portal', 'owner', 'agent'] }),
  f('plan', { writable_by: ['app'] }),                 // billing state
  f('last_outreach', { writable_by: ['agent'], rendered: false }),
];

const itemWith = (prov: Record<string, { source: string; actor: string; updated_at: string }>) =>
  ({ id: 'i1', status: 'published', [PROVENANCE_KEY]: prov }) as unknown as CollectionItem;

describe('writable_by defaults', () => {
  it('is portal + agent when undeclared — exactly the pre-existing behaviour', () => {
    expect(writableBy(f('x'))).toEqual(DEFAULT_WRITABLE_BY);
    expect(writableBy(f('x'))).toEqual(['portal', 'agent']);
  });

  it('never grants owner by default', () => {
    // Load-bearing: adding the public edit-link surface must not retroactively
    // expose fields on collections that predate it.
    expect(writableBy(f('x'))).not.toContain('owner');
  });

  it('treats an empty declared list as "unset" rather than "nobody"', () => {
    // A stored [] would otherwise lock a field permanently with no way back
    // through the API that wrote it.
    expect(writableBy(f('x', { writable_by: [] }))).toEqual(DEFAULT_WRITABLE_BY);
  });
});

describe('exclusivity', () => {
  it('refuses an agent write to an app-only field', () => {
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { plan: 'paid' }, existing: undefined,
      actor: 'agent', actorId: 'api-key:abc',
    });
    expect(r.update).toEqual({});
    expect(r.rejected).toEqual([{ field: 'plan', reason: 'not_writable' }]);
  });

  it('refuses an owner write to a field they were not granted', () => {
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { description: 'hi' }, existing: undefined,
      actor: 'owner', actorId: 'biz@example.com',
    });
    expect(r.rejected[0]).toMatchObject({ field: 'description', reason: 'not_writable' });
  });

  it('allows the owner on a field that granted them', () => {
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { phone: '070-1234567' }, existing: undefined,
      actor: 'owner', actorId: 'biz@example.com',
    });
    expect(r.update).toEqual({ phone: '070-1234567' });
    expect(r.provenance.phone).toMatchObject({ source: 'owner', actor: 'biz@example.com' });
  });
});

describe('precedence on shared fields', () => {
  it('blocks an agent from overwriting what the owner wrote', () => {
    // The whole point of the feature.
    const existing = itemWith({ phone: { source: 'owner', actor: 'biz@x', updated_at: 'T' } });
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { phone: '000' }, existing,
      actor: 'agent', actorId: 'api-key:abc',
    });
    expect(r.update).toEqual({});
    expect(r.rejected).toEqual([
      { field: 'phone', reason: 'lower_precedence', current_source: 'owner' },
    ]);
  });

  it('lets the portal overwrite anything', () => {
    const existing = itemWith({ phone: { source: 'owner', actor: 'biz@x', updated_at: 'T' } });
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { phone: '111' }, existing,
      actor: 'portal', actorId: 'staff@typeroll',
    });
    expect(r.update).toEqual({ phone: '111' });
    expect(r.rejected).toEqual([]);
  });

  it('lets an actor overwrite its own earlier write', () => {
    // Equal rank must pass, or an agent could never correct itself.
    const existing = itemWith({ description: { source: 'agent', actor: 'a', updated_at: 'T' } });
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { description: 'v2' }, existing,
      actor: 'agent', actorId: 'api-key:abc',
    });
    expect(r.update).toEqual({ description: 'v2' });
  });

  it('ranks import below agent — a re-run must not undo enrichment', () => {
    const existing = itemWith({ description: { source: 'agent', actor: 'a', updated_at: 'T' } });
    const r = applyFieldAuthority({
      fields: [f('description', { writable_by: ['portal', 'agent', 'import'] })],
      incoming: { description: 'from registry dump' }, existing,
      actor: 'import', actorId: 'seed-2026',
    });
    expect(r.rejected[0]).toMatchObject({ reason: 'lower_precedence', current_source: 'agent' });
  });

  it('writes the fields it can and rejects only the ones it cannot', () => {
    const existing = itemWith({ phone: { source: 'portal', actor: 'staff', updated_at: 'T' } });
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { description: 'new', phone: 'nope' }, existing,
      actor: 'agent', actorId: 'api-key:abc',
    });
    expect(r.update).toEqual({ description: 'new' });
    expect(r.rejected.map((x) => x.field)).toEqual(['phone']);
  });

  it('ignores keys that are not schema fields', () => {
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { _provenance: 'forged', status: 'published' },
      existing: undefined, actor: 'agent', actorId: 'a',
    });
    expect(r.update).toEqual({});
    expect(r.rejected).toEqual([]);
  });
});

describe('provenance bookkeeping', () => {
  it('preserves entries for fields this write did not touch', () => {
    const existing = itemWith({ description: { source: 'owner', actor: 'biz', updated_at: 'T1' } });
    const r = applyFieldAuthority({
      fields: FIELDS, incoming: { phone: '070' }, existing,
      actor: 'portal', actorId: 'staff',
    });
    expect(r.provenance.description).toMatchObject({ source: 'owner' });
    expect(r.provenance.phone).toMatchObject({ source: 'portal' });
  });

  it('reads a missing or malformed map as empty', () => {
    expect(readProvenance(undefined)).toEqual({});
    expect(readProvenance({ id: 'x' } as CollectionItem)).toEqual({});
  });

  it('stampProvenance records only schema fields', () => {
    const out = stampProvenance({
      fields: FIELDS,
      written: { description: 'a', status: 'published', updated_at: 'T' },
      existing: undefined, actor: 'agent', actorId: 'api-key:abc', now: 'T2',
    });
    expect(Object.keys(out)).toEqual(['description']);
    expect(out.description).toEqual({ source: 'agent', actor: 'api-key:abc', updated_at: 'T2' });
  });
});

describe('rendered:false', () => {
  it('defaults to rendered', () => {
    expect(isRenderedField(f('x'))).toBe(true);
  });

  it('marks an agent-only working field as not rendered', () => {
    expect(isRenderedField(FIELDS[3])).toBe(false);
  });
});

describe('conflictResponse', () => {
  it('names both the unwritable and the outranked fields', () => {
    const body = conflictResponse([
      { field: 'plan', reason: 'not_writable' },
      { field: 'phone', reason: 'lower_precedence', current_source: 'owner' },
    ]);
    expect(body.error).toContain('plan');
    expect(body.error).toContain('phone (owner)');
    // The machine-readable half is what lets an agent record the loss and
    // stop retrying instead of re-sending the same write forever.
    expect(body.rejected_fields).toHaveLength(2);
  });
});
