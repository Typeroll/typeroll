import { validateAnswerSources } from '../../../../../../lib/answer-source-input';
// POST /api/v1/sites/{siteId}/pages/batch-write
//
// Body: [{ page_id, patch: Partial<Page>, save?: boolean }]   — up to BATCH_MAX
// Returns: { results: Array<{ page_id, ok, saved, error?, warnings? }> }
//
// Buffer model: each patch's content fields land in that page's WORKING
// COPY; `status`/`date_published` apply immediately. Per-entry `save: true`
// commits the page's working copy (revision snapshot, SEO transform,
// redirect hygiene) in the same call — typical for pre-approved sweeps.
// Each entry is applied independently — one failed page doesn't abort the
// rest.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { applyContentWrite } from '../../../../../../lib/content-write';
import { checkAlternates } from '../../../../../../lib/page-alternates';
import { blockTreeWarnings, ensureBlockIds, type Page } from '@typeroll/shared';
import { blockTreeInputError } from '../../../../../../lib/block-tree-input';

const BATCH_MAX = 200;

const WRITABLE: Array<keyof Page> = [
  'title', 'slug', 'html_content', 'status', 'content_mode', 'kind', 'author',
  'breadcrumb_label', 'seo_title', 'append_seo_suffix', 'seo_description', 'og_image', 'canonical_url', 'noindex', 'nofollow',
  'alternates', 'json_ld', 'template', 'date_published',
  'path', 'fields', 'blocks', 'parent', 'sort_order', 'seo_image_alt', 'language',
  'lastmod_override', 'image_sizes_default', 'custom_css', 'publish_at', 'unpublish_at',
];

function pickWritable(body: Partial<Page>): Partial<Page> {
  const out: Partial<Page> = {};
  for (const k of WRITABLE) {
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k];
  }
  if (out.blocks !== undefined) out.blocks = ensureBlockIds(out.blocks);
  return out;
}

interface Item {
  page_id: unknown;
  patch?: unknown;
  save?: unknown;
  answer_sources?: unknown;
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) {
    return apiError('Body must be an array of { page_id, patch }');
  }
  if (body.length > BATCH_MAX) return apiError(`Too many entries (max ${BATCH_MAX})`);

  const results = await Promise.all(
    body.map(async (raw): Promise<{ page_id: string; ok: boolean; saved?: boolean; error?: string; warnings?: ReturnType<typeof blockTreeWarnings> }> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { page_id: '', ok: false, error: 'Each entry must be an object' };
      const item = raw as Item;
      const pageId = typeof item.page_id === 'string' ? item.page_id : '';
      if (!pageId) return { page_id: String(item.page_id ?? ''), ok: false, error: 'page_id required' };
      try {
        validateAnswerSources(item.answer_sources);
        if (item.patch && typeof item.patch === 'object' && 'answer_sources' in item.patch) return { page_id: pageId, ok: false, error: 'Set answer_sources on the batch entry, beside patch' };
        const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
        if (!existing) return { page_id: pageId, ok: false, error: 'not found' };
        const rawPatch = (item.patch ?? {}) as Partial<Page>;
        const blockError = blockTreeInputError(rawPatch.blocks);
        if (blockError) return { page_id: pageId, ok: false, error: blockError };
        if (rawPatch.content_mode !== undefined) {
          return {
            page_id: pageId,
            ok: false,
            error: 'content_mode cannot be changed in batch-write; use POST /api/v1/sites/{siteId}/pages/{pageId}/mode',
          };
        }
        // Per-entry, not whole-batch: one page's bad hreflang tag must not
        // abort the other 199 writes, but it must be reported as a failure
        // rather than written half-valid.
        const alt = checkAlternates(rawPatch);
        if (!alt.ok) return { page_id: pageId, ok: false, error: alt.error };
        const patch = pickWritable(rawPatch) as Record<string, unknown>;
        if (alt.present) patch.alternates = alt.value;
        if (Object.keys(patch).length === 0) {
          return { page_id: pageId, ok: false, error: 'no writable fields in patch' };
        }
        const result = await applyContentWrite(
          ctx, { kind: 'page', id: pageId }, patch,
          { save: item.save === true, updatedBy: `api-key:${ctx.keyPrefix}`, answerSources: item.answer_sources },
        );
        // Per entry, beside its own result: a sweep of 200 pages must say
        // which page carried the inert key, not that one of them did.
        const warnings = blockTreeWarnings((item.patch as { blocks?: unknown } | undefined)?.blocks);
        return { page_id: pageId, ok: true, saved: result.committed, ...(warnings.length ? { warnings } : {}) };
      } catch (e) {
        return { page_id: pageId, ok: false, error: e instanceof Error ? e.message : 'unknown error' };
      }
    }),
  );

  // body-for-audit summarises rather than dumps the full array (could be MB
  // of patches). The audit log just needs to show "10 pages touched".
  const summary = {
    count: body.length,
    page_ids_preview: body.slice(0, 5).map((b) => (b as Item).page_id),
  };
  return apiResponse(ctx, { results }, 200, summary);
};
