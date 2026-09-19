// Schema-leaf write authority and private provenance for Page answers.
import { isDeepStrictEqual } from 'node:util';
import type { FieldDefinition } from '@typeroll/shared';

/**
 * `import` is bulk seeding (registry dumps, migrations) — deliberately the
 * weakest, since it's the one most likely to run again over hand-corrected
 * data.
 */
export type WriteActor = 'portal' | 'owner' | 'agent' | 'app' | 'import';

/**
 * Higher wins. A write is allowed when the writer ranks at least as high as
 * the field's current source — so an actor can always overwrite itself, and
 * a human correction survives every later machine pass.
 */
const RANK: Record<WriteActor, number> = {
  portal: 4,
  owner: 3,
  app: 2,
  agent: 1,
  import: 0,
};

/**
 * Applied when a field declares no `writable_by`. Exactly today's behaviour —
 * the portal UI and API keys can write, and nothing else could anyway. The
 * owner surface (edit links) must be opted into per field, so adding it can
 * never retroactively expose an existing content type's fields to the public.
 */
export const DEFAULT_WRITABLE_BY: readonly WriteActor[] = ['portal', 'agent'];

export interface ProvenanceEntry {
  source: WriteActor;
  /** User email, API-key prefix, or agent id — whatever identifies the writer. */
  actor: string;
  updated_at: string;
  source_url?: string;
  import_run_id?: string;
  override_reason?: string;
}

/** Server-maintained, underscore-prefixed so no schema whitelist admits it. */
export type ProvenanceMap = Record<string, ProvenanceEntry>;

export const PROVENANCE_KEY = '_provenance';

export interface RejectedWrite {
  field: string;
  reason: 'not_writable' | 'lower_precedence' | 'override_required' | 'invalid_item_identity';
  /** Present for lower_precedence — who owns the value the write lost to. */
  current_source?: WriteActor;
}

export interface FieldAuthorityResult {
  /** Fields that survived, ready to merge into the item. */
  update: Record<string, unknown>;
  /** Merged provenance map to persist alongside them. */
  provenance: ProvenanceMap;
  /** Fields refused, with why. A non-empty list should surface as 409. */
  rejected: RejectedWrite[];
}

export function writableBy(field: FieldDefinition): readonly WriteActor[] {
  const declared = (field as { writable_by?: WriteActor[] }).writable_by;
  return declared && declared.length > 0 ? declared : DEFAULT_WRITABLE_BY;
}

/** Fields the renderer never sees — excluded from build snapshots + context. */
export function isRenderedField(field: FieldDefinition): boolean {
  return (field as { rendered?: boolean }).rendered !== false;
}

export function readProvenance(item: object | undefined): ProvenanceMap {
  const raw = (item as Record<string, unknown> | undefined)?.[PROVENANCE_KEY];
  return raw && typeof raw === 'object' ? (raw as ProvenanceMap) : {};
}

/**
 * Filter an incoming field patch by who's writing it.
 *
 * `incoming` should already be schema-whitelisted by the caller — this layer
 * answers "may THIS actor write THIS field", not "is this a real field".
 */
export function applyFieldAuthority(args: {
  fields: FieldDefinition[]; incoming: Record<string, unknown>; existing: object | undefined;
  actor: WriteActor; actorId: string; now?: string;
  sourceUrl?: string; importRunId?: string;
  sources?: Record<string, { source_url?: string; import_run_id?: string }>;
  /** Explicit administrative correction; callers must authorize it separately. */
  overrideReason?: string;
  /** Explicit confirmations are leaf paths, never inferred from a form save. */
  confirm?: string[];
}): FieldAuthorityResult {
  const now = args.now ?? new Date().toISOString();
  const current = readProvenance(args.existing);
  const existing = args.existing as Record<string, unknown> | undefined;
  const values = { ...(existing?.fields as Record<string, unknown> ?? {}), ...existing };
  const update: Record<string, unknown> = {};
  const provenance: ProvenanceMap = { ...current };
  const rejected: RejectedWrite[] = [];
  const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const sourceAt = (path: string): ProvenanceEntry | undefined => {
    for (let key = path; key; key = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '') if (current[key]) return current[key];
    return undefined;
  };
  const stamp = (path: string) => {
    provenance[path] = { source: args.actor, actor: args.actorId, updated_at: now,
      ...(args.sourceUrl ? { source_url: args.sourceUrl } : {}), ...(args.importRunId ? { import_run_id: args.importRunId } : {}),
      ...(args.sources?.[path]?.source_url ? { source_url: args.sources[path].source_url } : {}),
      ...(args.sources?.[path]?.import_run_id ? { import_run_id: args.sources[path].import_run_id } : {}),
      ...(args.overrideReason ? { override_reason: args.overrideReason } : {}) };
  };
  const allow = (path: string, allowed: readonly WriteActor[], before: unknown, after: unknown): boolean => {
    if (isDeepStrictEqual(before, after) && !args.confirm?.includes(path)) return true;
    if (!allowed.includes(args.actor)) { rejected.push({ field: path, reason: 'not_writable' }); return false; }
    const prior = sourceAt(path);
    if (prior && RANK[args.actor] < RANK[prior.source]) {
      rejected.push({ field: path, reason: 'lower_precedence', current_source: prior.source }); return false;
    }
    if (prior?.source === 'owner' && args.actor === 'portal' && !args.overrideReason?.trim()) {
      rejected.push({ field: path, reason: 'override_required', current_source: prior.source }); return false;
    }
    stamp(path); return true;
  };
  const walk = (field: FieldDefinition, before: unknown, after: unknown, path: string, inherited: readonly WriteActor[]): unknown => {
    const allowed = field.writable_by?.length ? field.writable_by : inherited;
    if (field.type === 'object' && field.fields && object(after)) {
      const base = object(before) ? before : {};
      const next = { ...base };
      for (const child of field.fields) if (Object.hasOwn(after, child.name))
        next[child.name] = walk(child, base[child.name], after[child.name], `${path}/${escape(child.name)}`, allowed);
      return next;
    }
    if (['array', 'list'].includes(field.type) && field.fields && field.item_key && Array.isArray(after)) {
      const key = field.item_key;
      const previous = Array.isArray(before) ? before : [];
      const valid = (rows: unknown[]) => rows.every(row => object(row) && typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 200)
        && new Set(rows.map(row => (row as Record<string, unknown>)[key])).size === rows.length;
      if (!valid(after) || !valid(previous)) {
        rejected.push({ field: path, reason: 'invalid_item_identity' }); return before;
      }
      const old = new Map(previous.map(row => [(row as Record<string, unknown>)[key], row]));
      const retained = new Set(after.map(row => row[key]));
      for (const row of previous) if (!retained.has(row[key]))
        walk({ ...field, type: 'object' }, row, undefined, `${path}/@${escape(row[key])}`, allowed);
      return after.map(row => walk({ ...field, type: 'object' }, old.get(row[key]), row, `${path}/@${escape(row[key])}`, allowed));
    }
    // Null resets and complete removals must authorize every affected leaf.
    // Unkeyed arrays are indivisible, never tracked by mutable numeric indexes.
    if (field.type === 'object' && field.fields && object(before)) {
      for (const child of field.fields) if (Object.hasOwn(before, child.name))
        walk(child, before[child.name], after === null ? null : undefined, `${path}/${escape(child.name)}`, allowed);
    }
    if (['array', 'list'].includes(field.type) && field.fields && field.item_key && Array.isArray(before)) {
      for (const row of before) if (object(row) && typeof row[field.item_key] === 'string')
        walk({ ...field, type: 'object' }, row, undefined, `${path}/@${escape(row[field.item_key] as string)}`, allowed);
    }
    if (!allow(path, allowed, before, after)) return before;
    // A schema change cannot erase older protected descendant provenance.
    if (!isDeepStrictEqual(before, after)) for (const key of Object.keys(current)) if (key.startsWith(path + '/'))
      allow(key, allowed, before, after);
    return after;
  };
  for (const field of args.fields) {
    if (!Object.hasOwn(args.incoming, field.name)) continue;
    const start = rejected.length;
    const previousProvenance = { ...provenance };
    const next = walk(field, values[field.name], args.incoming[field.name], field.name, writableBy(field));
    if (rejected.length === start) update[field.name] = next;
    else { for (const key of Object.keys(provenance)) delete provenance[key]; Object.assign(provenance, previousProvenance); }
  }
  return { update, provenance, rejected };
}

/**
 * Human-readable conflict body for a 409. Names the losing fields and who
 * holds them, so an agent can record the fact and stop retrying rather than
 * re-sending the same losing write on every pass.
 */
export function conflictResponse(rejected: RejectedWrite[]): {
  error: string;
  rejected_fields: RejectedWrite[];
} {
  const notWritable = rejected.filter((r) => r.reason === 'not_writable').map((r) => r.field);
  const outranked = rejected.filter((r) => r.reason === 'lower_precedence');
  const parts: string[] = [];
  for (const rejection of rejected.filter(item => ['override_required', 'invalid_item_identity'].includes(item.reason)))
    parts.push(`${rejection.field}: ${rejection.reason === 'override_required' ? 'an explicit administrative override reason is required' : 'array items need unique stable identities'}`);
  if (notWritable.length) {
    parts.push(`not writable by this surface: ${notWritable.join(', ')}`);
  }
  if (outranked.length) {
    parts.push(
      `held by a higher-precedence writer: ${outranked
        .map((r) => `${r.field} (${r.current_source})`)
        .join(', ')}`,
    );
  }
  return { error: `Some fields were not written — ${parts.join('; ')}`, rejected_fields: rejected };
}

/**
 * Provenance for a set of fields that have ALREADY been authorised and
 * written — the commit-time half of the pair. `applyFieldAuthority` decides
 * whether a write may happen; this records who did it once it has.
 *
 * Only schema fields are stamped: `status`, timestamps and anything else the
 * caller merges in isn't contended between surfaces.
 */
export function stampProvenance(args: {
  fields: FieldDefinition[];
  written: Record<string, unknown>;
  existing: object | undefined;
  actor: WriteActor;
  actorId: string;
  now?: string;
}): ProvenanceMap {
  const now = args.now ?? new Date().toISOString();
  const names = new Set(args.fields.map((f) => f.name));
  const out: ProvenanceMap = { ...readProvenance(args.existing) };
  for (const name of Object.keys(args.written)) {
    if (!names.has(name)) continue;
    out[name] = { source: args.actor, actor: args.actorId, updated_at: now };
  }
  return out;
}
