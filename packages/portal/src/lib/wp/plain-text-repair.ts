import { pageAuthorityFields, type ContentType, type Page } from '@typeroll/shared';
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
export type WordPressPlainTextRepairScope = 'pages' | 'all';

export interface WordPressPlainTextRepairOptions {
  /** Resource family to inspect. Defaults to both pages and collection items. */
  scope?: WordPressPlainTextRepairScope;
  /** Narrow the fixed field allowlist. Rich content, slugs and URLs are never accepted. */
  fields?: WordPressPlainTextRepairField[];
  pageIds?: string[];
  contentType?: string;
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
    { kind: 'page'; id: string };
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
  resource_counts: { pages: number };
  conflicts: WordPressPlainTextRepairConflict[];
  diffs: WordPressPlainTextRepairDiff[];
  diffs_shown: number;
  additional_diffs: number;
  truncated: boolean;
}

interface Candidate {
  target: WordPressPlainTextRepairDiff['target'];
  title: string;
  original: Page;
  fields: Partial<Record<WordPressPlainTextRepairField, unknown>>;
  contentType?: ContentType;
}

const PAGE_FIELDS = new Set<WordPressPlainTextRepairField>([
  'title',
  'seo_title',
  'seo_description',
]);
const CUSTOM_FIELD_TYPES = new Set(['text', 'textarea']);
const DEFAULT_DIFF_LIMIT = 500;
const MAX_DIFF_LIMIT = 2_000;

function workingCopyMatches(
  wc: { kind: string; target_id: string; collection?: string },
  target: WordPressPlainTextRepairDiff['target'],
): boolean {
  return wc.kind === target.kind
    && wc.target_id === target.id;
}

export async function repairWordPressPlainText(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: WordPressPlainTextRepairOptions,
): Promise<WordPressPlainTextRepairResult> {
  const scope = opts.scope ?? 'all';
  if (!['all', 'pages'].includes(scope)) throw new Error('Invalid scope');
  const dryRun = opts.dryRun ?? true;
  const save = opts.save ?? false;
  const updatedBy = opts.updatedBy ?? 'wordpress-plain-text-repair';
  const allowedFields = new Set<string>(WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS);
  const requestedFields = opts.fields ?? [...WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS];
  const invalidFields = requestedFields.filter((field) => !allowedFields.has(field));
  if (invalidFields.length > 0) {
    throw new Error(`Invalid fields: ${invalidFields.join(', ')}`);
  }
  const selectedFields = new Set<WordPressPlainTextRepairField>(requestedFields);
  const workingCopies = await listWorkingCopies({ orgId, siteId, versionId });
  const candidates: Candidate[] = [];

  if (scope === 'pages' || scope === 'all') {
    const restrictTo = opts.pageIds ? new Set(opts.pageIds) : null;
    const pages = (await vstore.pages(orgId, siteId, versionId)).filter(page => !opts.contentType || (page.content_type ?? 'page') === opts.contentType);
    const types = await vstore.contentTypes(orgId, siteId, versionId);
    for (const page of restrictTo ? pages.filter((entry) => restrictTo.has(entry.id)) : pages) {
      const contentType = types.find(type => type.id === (page.content_type ?? 'page'));
      candidates.push({
        contentType,
        target: { kind: 'page', id: page.id },
        title: page.title,
        original: page,
        fields: Object.fromEntries(
          [...selectedFields]
            .filter(field => PAGE_FIELDS.has(field) || contentType?.fields.some(definition => definition.name === field && CUSTOM_FIELD_TYPES.has(definition.type)))
            .map((field) => [field, PAGE_FIELDS.has(field) ? page[field as keyof Page] : page.fields?.[field]]),
        ),
      });
    }
  }

  let updated = 0;
  let saved = 0;
  let fieldsWithChanges = 0;
  let resourcesWithChanges = 0;
  const resourceCounts = { pages: 0 };
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

    if (candidate.contentType) {
      const authority = applyFieldAuthority({
        fields: pageAuthorityFields(candidate.contentType),
        incoming: changes,
        existing: candidate.original,
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

    if (!dryRun) {
      await mergeWorkingCopy(
        { orgId, siteId, versionId },
        candidate.target as WcTarget,
        { ...Object.fromEntries(Object.entries(changes).filter(([key]) => PAGE_FIELDS.has(key as WordPressPlainTextRepairField))),
          fields: Object.fromEntries(Object.entries(changes).filter(([key]) => !PAGE_FIELDS.has(key as WordPressPlainTextRepairField))),
        },
        updatedBy,
      );
      updated++;
      if (save) {
        const result = await commitWorkingCopy(
          { orgId, siteId, versionId },
          candidate.target as WcTarget,
          updatedBy,
          'agent',
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
