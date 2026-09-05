// POST /api/v1/sites/{siteId}/migration-urls/repair-plain-text
//
// Repair legacy WordPress entity encoding and markup in fields whose Typeroll
// contract is plain text. The operation is deliberately narrow and defaults
// to a dry run with exact field diffs. Rich content, slugs, paths and URLs can
// never enter the field allowlist.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import {
  repairWordPressPlainText,
  WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS,
  type WordPressPlainTextRepairField,
  type WordPressPlainTextRepairScope,
} from '../../../../../../lib/wp/plain-text-repair';

const SCOPES = new Set<WordPressPlainTextRepairScope>(['pages', 'collection_items', 'all']);
const FIELDS = new Set<string>(WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS);
const MAX_IDS = 2_000;
const MAX_DIFF_LIMIT = 2_000;

interface RepairBody {
  scope?: WordPressPlainTextRepairScope;
  fields?: WordPressPlainTextRepairField[];
  page_ids?: string[];
  collection?: string;
  item_ids?: string[];
  dry_run?: boolean;
  save?: boolean;
  diff_limit?: number;
}

function validStringArray(value: unknown, max = MAX_IDS): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= max
    && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as RepairBody | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body');

  if (body.scope !== undefined && !SCOPES.has(body.scope)) {
    return apiError('scope must be pages, collection_items, or all');
  }
  if (body.fields !== undefined) {
    if (!validStringArray(body.fields, WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS.length)
      || body.fields.some((field) => !FIELDS.has(field))) {
      return apiError(`fields must contain one or more of: ${WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS.join(', ')}`);
    }
  }
  if (body.page_ids !== undefined && !validStringArray(body.page_ids)) {
    return apiError(`page_ids must contain 1-${MAX_IDS} non-empty strings`);
  }
  if (body.item_ids !== undefined && !validStringArray(body.item_ids)) {
    return apiError(`item_ids must contain 1-${MAX_IDS} non-empty strings`);
  }
  if (body.collection !== undefined && (typeof body.collection !== 'string' || !body.collection)) {
    return apiError('collection must be a non-empty string');
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
    return apiError('dry_run must be a boolean');
  }
  if (body.save !== undefined && typeof body.save !== 'boolean') {
    return apiError('save must be a boolean');
  }
  if (body.diff_limit !== undefined && (
    !Number.isInteger(body.diff_limit) || body.diff_limit < 1 || body.diff_limit > MAX_DIFF_LIMIT
  )) {
    return apiError(`diff_limit must be an integer from 1 to ${MAX_DIFF_LIMIT}`);
  }
  const dryRun = body.dry_run ?? true;
  if (dryRun && body.save === true) return apiError('save requires dry_run: false');

  try {
    const result = await repairWordPressPlainText(ctx.orgId, ctx.siteId, ctx.versionId, {
      scope: body.scope,
      fields: body.fields,
      pageIds: body.page_ids,
      collection: body.collection,
      itemIds: body.item_ids,
      dryRun,
      save: body.save ?? false,
      diffLimit: body.diff_limit,
      updatedBy: `api-key:${ctx.keyPrefix}`,
    });
    return apiResponse(ctx, result, 200, {
      scope: body.scope ?? 'all',
      fields: body.fields ?? WORDPRESS_PLAIN_TEXT_REPAIR_FIELDS,
      dry_run: dryRun,
      save: body.save ?? false,
      resources_with_changes: result.resources_with_changes,
      fields_with_changes: result.fields_with_changes,
      conflicts: result.conflicts.length,
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Plain-text repair failed', 400);
  }
};
