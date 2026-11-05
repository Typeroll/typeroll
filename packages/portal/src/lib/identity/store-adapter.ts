// Better Auth database adapter over Typeroll's document store (getStore()).
//
// Every model is one collection, `${prefix}_${model}/{id}`, so two Better Auth
// instances with different prefixes never share a row. All paths live outside
// `organizations/`, which keeps them in the global object of the sharded store.
//
// Guarantees the library relies on:
// - Unique fields (user email, session token, …) are claimed through index
//   documents in the same conditional commit as the row, so two concurrent
//   sign-ups for one address cannot both succeed. An index whose row is gone or
//   no longer holds the value is stale and may be taken over.
// - consumeOne marks the row consumed in one conditional update; exactly one
//   caller wins. The row is deleted afterwards and is invisible meanwhile.
// - incrementOne and update are compare-and-replace loops on the row.
//
// Filters are evaluated here in full. Plain equality filters are also passed to
// the store so it can narrow the scan; the store never decides the result alone.

import { createHash } from 'node:crypto';
import { createAdapterFactory, type CleanedWhere } from 'better-auth/adapters';
import type { BetterAuthRateLimitStorage } from 'better-auth';
import type { ConditionalEffect, Filter, ReadWriteStore } from '../datastore';

const CONSUMED = '__consumed';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ATTEMPTS = 16;

type Row = Record<string, unknown> & { id: string };

export interface StoreAdapterOptions {
  /** Resolved per operation so tests and request-scoped stores are honored. */
  store: () => ReadWriteStore;
  /** Collection prefix; distinct per Better Auth instance. */
  prefix: string;
  adapterId?: string;
}

export class UniqueConstraintError extends Error {
  constructor(model: string, field: string) {
    super(`A ${model} with this ${field} already exists`);
    this.name = 'UniqueConstraintError';
  }
}

export function storeAdapter({ store, prefix, adapterId = 'typeroll-store' }: StoreAdapterOptions) {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid identity collection prefix');
  return createAdapterFactory({
    config: {
      adapterId,
      adapterName: 'Typeroll document store',
      supportsNumericIds: false,
      supportsUUIDs: false,
      supportsJSON: true,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: true,
      transaction: false,
    },
    adapter: ({ schema, getDefaultModelName, getFieldName }) => {
      const collection = (model: string) => `${prefix}_${model}`;
      const docPath = (model: string, id: string) => {
        if (!ID.test(id)) throw new Error('Invalid identity record id');
        return `${collection(model)}/${id}`;
      };
      const uniqueFields = (model: string): string[] => {
        const fields = schema[getDefaultModelName(model)]?.fields ?? {};
        return Object.entries(fields).filter(([, attribute]) => attribute.unique)
          .map(([field]) => getFieldName({ model, field }));
      };
      const indexPath = (model: string, field: string, value: unknown) =>
        `${prefix}_unique/${createHash('sha256').update(`${model}\u0000${field}\u0000${JSON.stringify(value)}`).digest('hex')}`;

      const visible = (row: Row | null): row is Row => !!row && row[CONSUMED] !== true;
      const output = (row: Row): Row => { const { [CONSUMED]: _consumed, ...rest } = row; void _consumed; return rest as Row; };
      const stored = (data: Record<string, unknown>) => { const { id: _id, [CONSUMED]: _c, ...rest } = data; void _id; void _c; return rest; };

      async function rows(model: string, where: CleanedWhere[] = []): Promise<Row[]> {
        const s = store();
        const byId = singleIdLookup(where);
        if (byId !== undefined) {
          const row = ID.test(byId) ? await s.getDoc<Row>(docPath(model, byId)) : null;
          return visible(row) && matches(row, where) ? [row] : [];
        }
        const all = await s.listDocs<Row>(collection(model), { filters: pushdown(where) });
        return all.filter(row => visible(row) && matches(row, where));
      }

      /** Effects that claim each unique value of `next` for row `id`. */
      async function uniqueEffects(model: string, id: string, next: Record<string, unknown>, previous: Record<string, unknown> | null): Promise<ConditionalEffect[]> {
        const s = store();
        const effects: ConditionalEffect[] = [];
        for (const field of uniqueFields(model)) {
          const value = next[field];
          if (value === undefined || value === null) continue;
          if (previous && isSame(previous[field], value)) continue;
          const path = indexPath(model, field, value);
          const index = await s.getDoc<{ owner: string; model: string; field: string }>(path);
          if (index && index.owner !== id) {
            const owner = typeof index.owner === 'string' && ID.test(index.owner) ? await s.getDoc<Row>(docPath(model, index.owner)) : null;
            if (visible(owner) && isSame(owner[field], value)) throw new UniqueConstraintError(model, field);
          }
          effects.push({ path, data: { model, field, owner: id }, expected: index ?? null, replace: true });
        }
        return effects;
      }

      /** Replace one row with `compute(current)` under compare-and-set. */
      async function replaceRow(model: string, where: CleanedWhere[], compute: (current: Row) => Record<string, unknown>): Promise<Row | null> {
        const s = store();
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const [current] = await rows(model, where);
          if (!current) return null;
          const next = { ...stored(current), ...stored(compute(current)) };
          const effects = await uniqueEffects(model, current.id, next, current);
          if (await s.compareAndReplaceDoc(docPath(model, current.id), current, next, effects)) {
            return { ...next, id: current.id };
          }
        }
        throw new Error('Identity record is changing too often; try again');
      }

      return {
        async create({ model, data }) {
          const row = data as Record<string, unknown>;
          const id = String(row.id ?? '');
          const next = stored(row);
          const effects = await uniqueEffects(model, id, next, null);
          if (!await store().compareAndReplaceDoc(docPath(model, id), null, next, effects)) {
            // A concurrent claim of a unique value (thrown here), or an existing id.
            await uniqueEffects(model, id, next, null);
            throw new UniqueConstraintError(model, 'id');
          }
          return { ...next, id } as typeof data;
        },

        async findOne({ model, where, join }) {
          if (join) throw new Error('Joins are not supported by the identity store adapter');
          const [row] = await rows(model, where);
          return (row ? output(row) : null) as never;
        },

        async findMany({ model, where, limit, sortBy, offset, join }) {
          if (join) throw new Error('Joins are not supported by the identity store adapter');
          let found = (await rows(model, where)).map(output);
          if (sortBy) found = found.sort((a, b) => compareValues(a[sortBy.field], b[sortBy.field]) * (sortBy.direction === 'asc' ? 1 : -1));
          if (offset) found = found.slice(offset);
          return found.slice(0, limit) as never;
        },

        async count({ model, where }) {
          return (await rows(model, where)).length;
        },

        async update({ model, where, update }) {
          if (!where.length) return null;
          const row = await replaceRow(model, where, () => update as Record<string, unknown>);
          return (row ? output(row) : null) as never;
        },

        async updateMany({ model, where, update }) {
          let changed = 0;
          for (const row of await rows(model, where)) {
            if (await replaceRow(model, [idClause(row.id), ...guarded(where)], () => update)) changed++;
          }
          return changed;
        },

        async delete({ model, where }) {
          if (!where.length) return;
          const [row] = await rows(model, where);
          if (row) await store().deleteDoc(docPath(model, row.id));
        },

        async deleteMany({ model, where }) {
          const found = await rows(model, where);
          for (const row of found) await store().deleteDoc(docPath(model, row.id));
          return found.length;
        },

        async consumeOne({ model, where }) {
          const s = store();
          for (const candidate of await rows(model, where)) {
            const won = await s.compareAndUpdateDoc<Row>(docPath(model, candidate.id),
              current => visible(current) && matches(current, where), { [CONSUMED]: true });
            if (!won) continue;
            await s.deleteDoc(docPath(model, candidate.id));
            return output(won) as never;
          }
          return null;
        },

        async incrementOne({ model, where, increment, set }) {
          const row = await replaceRow(model, where, current => {
            const next: Record<string, unknown> = { ...(set ?? {}) };
            for (const [field, delta] of Object.entries(increment)) {
              next[field] = (typeof current[field] === 'number' ? current[field] as number : 0) + delta;
            }
            return next;
          });
          return (row ? output(row) : null) as never;
        },
      };
    },
  });
}

/** Rate-limit storage for Better Auth: one fixed-window counter per key. */
export function storeRateLimitStorage(store: () => ReadWriteStore, prefix: string): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      const result = await consumeRateLimit(store(), `${prefix}_rate_limits`, key, rule.max, rule.window * 1000);
      return { allowed: result.allowed, retryAfter: result.allowed ? null : result.retryAfterSeconds };
    },
  };
}

export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number }

/** Atomic fixed-window counter. Throws when storage keeps failing; callers fail closed. */
export async function consumeRateLimit(store: ReadWriteStore, collectionPath: string, key: string, max: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
  const path = `${collectionPath}/${createHash('sha256').update(key).digest('hex')}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await store.getDoc<{ count: number; reset_at: number }>(path);
    const active = !!current && current.reset_at > now;
    if (active && current!.count >= max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current!.reset_at - now) / 1000)) };
    }
    const next = { count: active ? current!.count + 1 : 1, reset_at: active ? current!.reset_at : now + windowMs };
    if (await store.compareAndReplaceDoc(path, current, next)) return { allowed: true, retryAfterSeconds: 0 };
  }
  throw new Error('Rate limit storage is contended');
}

// ─── where-clause evaluation ──────────────────────────────────────────────

function idClause(id: string): CleanedWhere {
  return { field: 'id', operator: 'eq', value: id, connector: 'AND', mode: 'sensitive' };
}

/** `where` re-applied as a guard next to an id selector. OR clauses stay one group. */
function guarded(where: CleanedWhere[]): CleanedWhere[] {
  return where.some(clause => clause.connector === 'OR') ? [] : where;
}

function singleIdLookup(where: CleanedWhere[]): string | undefined {
  if (where.some(clause => clause.connector === 'OR')) return undefined;
  const id = where.find(clause => clause.field === 'id' && clause.operator === 'eq' && clause.mode !== 'insensitive' && typeof clause.value === 'string');
  return id?.value as string | undefined;
}

function pushdown(where: CleanedWhere[]): Filter[] {
  if (where.some(clause => clause.connector === 'OR')) return [];
  return where.filter(clause => clause.field !== 'id' && clause.operator === 'eq' && clause.mode !== 'insensitive'
    && (typeof clause.value === 'string' || typeof clause.value === 'number' || typeof clause.value === 'boolean'))
    .map(clause => ({ field: clause.field, op: '==' as const, value: clause.value }));
}

/** Same combination rule as Better Auth's own adapters: left to right, each clause joined by its connector. */
export function matches(row: Record<string, unknown>, where: CleanedWhere[]): boolean {
  if (!where.length) return true;
  let result = clauseMatches(row, where[0]!);
  for (const clause of where.slice(1)) {
    const value = clauseMatches(row, clause);
    result = clause.connector === 'OR' ? result || value : result && value;
  }
  return result;
}

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function clauseMatches(row: Record<string, unknown>, clause: CleanedWhere): boolean {
  const actual = normalize(row[clause.field]);
  const expected = Array.isArray(clause.value) ? (clause.value as unknown[]).map(normalize) : normalize(clause.value);
  const insensitive = clause.mode === 'insensitive';
  const fold = (value: unknown) => insensitive && typeof value === 'string' ? value.toLowerCase() : value;
  const a = fold(actual);
  switch (clause.operator) {
    case 'in': return Array.isArray(expected) && expected.map(fold).includes(a);
    case 'not_in': return Array.isArray(expected) && !expected.map(fold).includes(a);
    case 'contains': return typeof a === 'string' && typeof expected === 'string' && a.includes(fold(expected) as string);
    case 'starts_with': return typeof a === 'string' && typeof expected === 'string' && a.startsWith(fold(expected) as string);
    case 'ends_with': return typeof a === 'string' && typeof expected === 'string' && a.endsWith(fold(expected) as string);
    case 'ne': return expected === null ? actual !== undefined && actual !== null : a !== fold(expected);
    case 'gt': return expected != null && actual != null && compareValues(actual, expected) > 0;
    case 'gte': return expected != null && actual != null && compareValues(actual, expected) >= 0;
    case 'lt': return expected != null && actual != null && compareValues(actual, expected) < 0;
    case 'lte': return expected != null && actual != null && compareValues(actual, expected) <= 0;
    default: return expected === null ? actual === undefined || actual === null : a === fold(expected);
  }
}

function compareValues(a: unknown, b: unknown): number {
  a = normalize(a); b = normalize(b);
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
