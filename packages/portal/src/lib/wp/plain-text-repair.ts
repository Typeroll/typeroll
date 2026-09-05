import type { CollectionDef, CollectionItem, Page } from '@typeroll/shared';
import { applyFieldAuthority } from '../field-authority';
import { vstore } from '../version-store';
import {
  commitWorkingCopy,
  listWorkingCopies,
  mergeWorkingCopy,
  type WcTarget,
} from '../working-copy';
import { normalizeWordPressPlainText } from './plain-text';

export const WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS = [
  'title',
  'seo_title',
  'seo_description',
  'excerpt',
] as const;

export type WordPressPlainTextRepairField = typeof WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS[number];
export type WordPressPlainTextRepairScope = 'pages' | 'collection_items' | 'all';

export interface WordPressPlainTextRepairOptions {
  /** Resource family to inspect. Defaults to both pages and collection items. */
  scope?: WordPressPlainTextRepairScope;
  /** Narrow the fixed field allowlist. Rich content, slugs and URLs are never accepted. */
  fields?: WordPressPlainTextRepairField[];
  pageIds?: string[];
  collection?: string;
  itemIds?: string[];
  /** Safe default: report exact field diffs without writing. */
  dryRun?: boolean;
  /** Commit through the normal revision/write path after staging each change. */
  save?: boolean;
  updatedBy?: string;
  /** Number of exact field diffs returned. Defaults to 500, maximum 2,000. */
  diffLimit?: number;
}

export interface WordPressPlainTextRepairDiff {
  target:
    | { kind: 'page'; id: string }
    | { kind: 'item'; id: string; collection: string };
  title: string;
  field: WordPressPlainTextRepairField;
  before: string;
  after: string;
}

export interface WordPressPlainTextRepairConflict {
  target: WordPressPlainTextRepairDiff['target'];
  reason: 'working_copy' | 'field_authority';
  fields: WordPressPlainTextRepairField[];
}

export interface WordPressPlainTextRepairResult {
  dry_run: boolean;
  updated: number;
  saved: number;
  resources_scanned: number;
  resources_with_changes: number;
  fields_with_changes: number;
  resource_counts: { pages: number; collection_items: number };
  conflicts: WordPressPlainTextRepairConflict[];
  diffs: WordPressPlainTextRepairDiff[];
  diffs_shown: number;
  additional_diffs: number;
  truncated: boolean;
}

interface Candidate {
  target: WordPressPlainTextRepairDiff['target'];
  title: string;
  original: Page | CollectionItem;
  fields: Partial<Record<WordPressPlainTextRepairField, unknown>>;
  collectionDef?: CollectionDef;
}

const PAGE_FIELDS = new Set<WordPressPlainTextRepairField>([
  'title',
  'seo_title',
  'seo_description',
]);
const COLLECTION_FIELD_TYPES = new Set(['text', 'textarea']);
const DEFAULT_DIFF_LIMIT = 500;
const MAX_DIFF_LIMIT = 2_000;

function workingCopyMatches(
  wc: { kind: string; target_id: string; collection?: string },
  target: WordPressPlainTextRepairDiff['target'],
): boolean {
  return wc.kind === target.kind
    && wc.target_id === target.id
    && (target.kind !== 'item' || wc.collection === target.collection);
}

export async function repairWordPressPlainText(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: WordPressPlainTextRepairOptions,
): Promise<WordPressPlainTextRepairResult> {
  const scope = opts.scope ?? 'all';
  const dryRun = opts.dryRun ?? true;
  const save = opts.save ?? false;
  const updatedBy = opts.updatedBy ?? 'wordpress-plain-text-repair';
  const allowedFields = new Set<string>(WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS);
  const requestedFields = opts.fields ?? [...WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS];
  const invalidFields = requestedFields.filter((field) => !allowedFields.has(field));
  if (invalidFields.length > 0) {
    throw new Error(`Invalid fields: ${invalidFields.join(', ')}`);
  }
  if (opts.itemIds && !opts.collection) throw new Error('collection required when item_ids is set');
  if (opts.pageIds && scope !== 'pages' && scope !== 'all') {
    throw new Error('page_ids requires scope pages or all');
  }
  if ((opts.collection || opts.itemIds) && scope !== 'collection_items' && scope !== 'all') {
    throw new Error('collection and item_ids require scope collection_items or all');
  }

  const selectedFields = new Set<WordPressPlainTextRepairField>(requestedFields);
  const workingCopies = await listWorkingCopies({ orgId, siteId, versionId });
  const candidates: Candidate[] = [];

  if (scope === 'pages' || scope === 'all') {
    const restrictTo = opts.pageIds ? new Set(opts.pageIds) : null;
    const pages = await vstore.pages(orgId, siteId, versionId);
    for (const page of restrictTo ? pages.filter((entry) => restrictTo.has(entry.id)) : pages) {
      candidates.push({
        target: { kind: 'page', id: page.id },
        title: page.title,
        original: page,
        fields: Object.fromEntries(
          [...selectedFields]
            .filter((field) => PAGE_FIELDS.has(field))
            .map((field) => [field, page[field as keyof Page]]),
        ),
      });
    }
  }

  if (scope === 'collection_items' || scope === 'all') {
    const definitions = opts.collection
      ? [await vstore.collection(orgId, siteId, versionId, opts.collection)].filter(Boolean) as CollectionDef[]
      : await vstore.collections(orgId, siteId, versionId);
    if (opts.collection && definitions.length === 0) {
      throw new Error(`Collection not found: ${opts.collection}`);
    }
    const restrictTo = opts.itemIds ? new Set(opts.itemIds) : null;
    for (const definition of definitions) {
      const repairFields = definition.fields.filter((field) => (
        selectedFields.has(field.name as WordPressPlainTextRepairField)
        && allowedFields.has(field.name)
        && COLLECTION_FIELD_TYPES.has(field.type)
      ));
      if (repairFields.length === 0) continue;
      const items = await vstore.collectionItems(orgId, siteId, versionId, definition.name);
      for (const item of restrictTo ? items.filter((entry) => restrictTo.has(entry.id)) : items) {
        candidates.push({
          target: { kind: 'item', id: item.id, collection: definition.name },
          title: String(item[definition.slug_field ?? 'slug'] ?? item.id),
          original: item,
          collectionDef: definition,
          fields: Object.fromEntries(repairFields.map((field) => [field.name, item[field.name]])),
        });
      }
    }
  }

  let updated = 0;
  let saved = 0;
  let fieldsWithChanges = 0;
  let resourcesWithChanges = 0;
  const resourceCounts = { pages: 0, collection_items: 0 };
  const conflicts: WordPressPlainTextRepairConflict[] = [];
  const allDiffs: WordPressPlainTextRepairDiff[] = [];

  for (const candidate of candidates) {
    const changes: Partial<Record<WordPressPlainTextRepairField, string>> = {};
    const candidateDiffs: WordPressPlainTextRepairDiff[] = [];
    for (const [field, value] of Object.entries(candidate.fields)) {
      if (typeof value !== 'string') continue;
      const after = normalizeWordPressPlainText(value);
      if (after === value) continue;
      const repairField = field as WordPressPlainTextRepairField;
      changes[repairField] = after;
      candidateDiffs.push({
        target: candidate.target,
        title: candidate.title,
        field: repairField,
        before: value,
        after,
      });
    }
    if (candidateDiffs.length === 0) continue;

    if (workingCopies.some((wc) => workingCopyMatches(wc, candidate.target))) {
      conflicts.push({
        target: candidate.target,
        reason: 'working_copy',
        fields: candidateDiffs.map((diff) => diff.field),
      });
      continue;
    }

    if (candidate.target.kind === 'item' && candidate.collectionDef) {
      const authority = applyFieldAuthority({
        fields: candidate.collectionDef.fields,
        incoming: changes,
        existing: candidate.original as CollectionItem,
        actor: 'agent',
        actorId: updatedBy,
      });
      if (authority.rejected.length > 0) {
        conflicts.push({
          target: candidate.target,
          reason: 'field_authority',
          fields: authority.rejected.map((entry) => entry.field as WordPressPlainTextRepairField),
        });
        continue;
      }
    }

    resourcesWithChanges++;
    fieldsWithChanges += candidateDiffs.length;
    allDiffs.push(...candidateDiffs);
    if (candidate.target.kind === 'page') resourceCounts.pages++;
    else resourceCounts.collection_items++;

    if (!dryRun) {
      await mergeWorkingCopy(
        { orgId, siteId, versionId },
        candidate.target as WcTarget,
        changes,
        updatedBy,
      );
      updated++;
      if (save) {
        const result = await commitWorkingCopy(
          { orgId, siteId, versionId },
          candidate.target as WcTarget,
          updatedBy,
          candidate.target.kind === 'item' ? 'agent' : undefined,
        );
        if (result.committed) saved++;
      }
    }
  }

  const diffLimit = Math.min(
    Math.max(1, Math.floor(opts.diffLimit ?? DEFAULT_DIFF_LIMIT)),
    MAX_DIFF_LIMIT,
  );
  const diffs = allDiffs.slice(0, diffLimit);
  return {
    dry_run: dryRun,
    updated,
    saved,
    resources_scanned: candidates.length,
    resources_with_changes: resourcesWithChanges,
    fields_with_changes: fieldsWithChanges,
    resource_counts: resourceCounts,
    conflicts,
    diffs,
    diffs_shown: diffs.length,
    additional_diffs: allDiffs.length - diffs.length,
    truncated: allDiffs.length > diffs.length,
  };
}
