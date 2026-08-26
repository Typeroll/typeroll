// "What's missing" for a collection — the read that makes agent enrichment
// self-directing.
//
// Without it an enrichment agent has to page the entire collection and diff
// it client-side on every run, which is both slow and stateful: it has to
// remember what it already looked at. With it the agent asks for the fifty
// worst records and works those.
//
// Modelled on `analyzeCoverage()` from the migration workflow, including the
// part that matters most: **status is computed at read time, never stored.**
// A stored completeness score is wrong the moment anyone edits an item, and
// nothing would tell you it had gone stale.

import type { CollectionDef, CollectionItem, FieldDefinition } from '@typeroll/shared';
import { readProvenance, writableBy, type WriteActor } from './field-authority';

export interface FieldGap {
  field: string;
  label: string;
  required: boolean;
}

export interface ItemCompleteness {
  id: string;
  /** Best-effort human label, for an agent's log and the portal's table. */
  title: string;
  status: string;
  /** Schema fields with no value. */
  missing: FieldGap[];
  /** 0–1 over the fields an agent could actually fill. 1 = nothing missing. */
  score: number;
  /** Fields never written by anyone — no provenance entry at all. */
  unverified: string[];
  /** Fields whose last write is older than the staleness window. */
  stale: Array<{ field: string; source: WriteActor; updated_at: string }>;
}

export interface CompletenessReport {
  collection: string;
  total_items: number;
  /** Items with at least one missing REQUIRED field. */
  incomplete_items: number;
  /** Mean score across all items, 0–1. */
  average_score: number;
  /** Per-field counts, so an operator can see which column is systematically empty. */
  field_gaps: Array<{ field: string; label: string; required: boolean; missing_count: number }>;
  /** Worst-first, capped by `limit`. */
  items: ItemCompleteness[];
  /**
   * How many items the `items` array left out. Named explicitly because a
   * truncated list that reads like a full one is how "we covered everything"
   * becomes false.
   */
  truncated: number;
}

export interface CompletenessOptions {
  /** Max items in the report body. Default 50. */
  limit?: number;
  /** A field untouched for longer than this counts as stale. Default 180. */
  stale_after_days?: number;
  /** Only report items an agent could actually act on. Default true. */
  agent_writable_only?: boolean;
  now?: Date;
}

function isEmpty(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function labelFor(item: CollectionItem): string {
  const d = item as Record<string, unknown>;
  for (const key of ['title', 'name', 'company_name', 'slug']) {
    const v = d[key];
    if (typeof v === 'string' && v) return v;
  }
  return item.id;
}

/**
 * Which fields count toward completeness. Excludes fields no external writer
 * can fill — reporting a gap an agent is forbidden to close would just be
 * noise it can never clear.
 */
function scorableFields(coll: Pick<CollectionDef, 'fields'>, agentOnly: boolean): FieldDefinition[] {
  return (coll.fields ?? []).filter((f) => !agentOnly || writableBy(f).includes('agent'));
}

export function analyzeCompleteness(
  coll: Pick<CollectionDef, 'name' | 'fields'>,
  items: CollectionItem[],
  opts: CompletenessOptions = {},
): CompletenessReport {
  const limit = opts.limit ?? 50;
  const staleMs = (opts.stale_after_days ?? 180) * 24 * 60 * 60 * 1000;
  const now = (opts.now ?? new Date()).getTime();
  const fields = scorableFields(coll, opts.agent_writable_only !== false);

  const gapCounts = new Map<string, number>();
  const analysed: ItemCompleteness[] = [];

  for (const item of items) {
    const data = item as Record<string, unknown>;
    const provenance = readProvenance(item);
    const missing: FieldGap[] = [];
    const unverified: string[] = [];
    const stale: ItemCompleteness['stale'] = [];

    for (const f of fields) {
      if (isEmpty(data[f.name])) {
        missing.push({ field: f.name, label: f.label, required: f.required === true });
        gapCounts.set(f.name, (gapCounts.get(f.name) ?? 0) + 1);
        // A field that's empty isn't also "unverified" or "stale" — those
        // describe values that exist but may no longer be true.
        continue;
      }
      const entry = provenance[f.name];
      if (!entry) {
        unverified.push(f.name);
        continue;
      }
      const at = Date.parse(entry.updated_at);
      if (!Number.isNaN(at) && now - at > staleMs) {
        stale.push({ field: f.name, source: entry.source, updated_at: entry.updated_at });
      }
    }

    analysed.push({
      id: item.id,
      title: labelFor(item),
      status: item.status,
      missing,
      score: fields.length === 0 ? 1 : (fields.length - missing.length) / fields.length,
      unverified,
      stale,
    });
  }

  // Worst first: required gaps dominate, then total gaps, then staleness —
  // an agent working top-down should hit the highest-value records first.
  const ranked = [...analysed].sort((a, b) => {
    const aReq = a.missing.filter((m) => m.required).length;
    const bReq = b.missing.filter((m) => m.required).length;
    if (aReq !== bReq) return bReq - aReq;
    if (a.missing.length !== b.missing.length) return b.missing.length - a.missing.length;
    return b.stale.length - a.stale.length;
  });

  return {
    collection: coll.name,
    total_items: items.length,
    incomplete_items: analysed.filter((i) => i.missing.some((m) => m.required)).length,
    average_score: analysed.length === 0
      ? 1
      : analysed.reduce((sum, i) => sum + i.score, 0) / analysed.length,
    field_gaps: fields.map((f) => ({
      field: f.name,
      label: f.label,
      required: f.required === true,
      missing_count: gapCounts.get(f.name) ?? 0,
    })).sort((a, b) => b.missing_count - a.missing_count),
    items: ranked.slice(0, limit),
    truncated: Math.max(0, ranked.length - limit),
  };
}
