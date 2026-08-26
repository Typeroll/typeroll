// Per-field write authority and provenance for collection items.
//
// A directory has four kinds of writer touching the same record — a portal
// operator, the listed business itself (through a one-time edit link), an
// enrichment agent, and the app's own server logic (billing state). Without
// per-field rules they overwrite each other silently: the business corrects
// its description on Monday and a scraper restores the stale one on Tuesday.
// Nobody notices until a customer complains.
//
// Two independent mechanisms, deliberately not conflated:
//
//   writable_by  — WHO MAY write a field at all. Exclusivity. A `type` field
//                  marked ['app'] can't be touched by the business or an
//                  agent, full stop.
//   provenance   — WHO LAST WROTE IT, per field, so a contended field can be
//                  resolved by precedence instead of by whoever ran last.
//
// The precedence ladder only decides SHARED fields; exclusive ones never
// reach it. And a rejected write returns a conflict rather than silently
// no-op'ing: a silent drop leaves an agent believing it succeeded, so it
// retries the same write forever and its own store drifts out of sync with
// what's actually published.

import type { CollectionItem, FieldDefinition } from '@typeroll/shared';

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
 * never retroactively expose an existing collection's fields to the public.
 */
export const DEFAULT_WRITABLE_BY: readonly WriteActor[] = ['portal', 'agent'];

export interface ProvenanceEntry {
  source: WriteActor;
  /** User email, API-key prefix, or agent id — whatever identifies the writer. */
  actor: string;
  updated_at: string;
}

/** Server-maintained, underscore-prefixed so no schema whitelist admits it. */
export type ProvenanceMap = Record<string, ProvenanceEntry>;

export const PROVENANCE_KEY = '_provenance';

export interface RejectedWrite {
  field: string;
  reason: 'not_writable' | 'lower_precedence';
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

export function readProvenance(item: CollectionItem | undefined): ProvenanceMap {
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
  fields: FieldDefinition[];
  incoming: Record<string, unknown>;
  existing: CollectionItem | undefined;
  actor: WriteActor;
  actorId: string;
  now?: string;
}): FieldAuthorityResult {
  const now = args.now ?? new Date().toISOString();
  const current = readProvenance(args.existing);
  const byName = new Map(args.fields.map((f) => [f.name, f]));

  const update: Record<string, unknown> = {};
  const provenance: ProvenanceMap = { ...current };
  const rejected: RejectedWrite[] = [];

  for (const [name, value] of Object.entries(args.incoming)) {
    const field = byName.get(name);
    if (!field) continue; // not a schema field — caller's whitelist owns this

    if (!writableBy(field).includes(args.actor)) {
      rejected.push({ field: name, reason: 'not_writable' });
      continue;
    }

    const owner = current[name]?.source;
    if (owner && RANK[args.actor] < RANK[owner]) {
      rejected.push({ field: name, reason: 'lower_precedence', current_source: owner });
      continue;
    }

    update[name] = value;
    provenance[name] = { source: args.actor, actor: args.actorId, updated_at: now };
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
  existing: CollectionItem | undefined;
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
