// GET /api/v1/sites/{siteId}/migration-preflight[?source_url=https://old.example.com]
//
// Is this site ready to receive a migration? Read-only, cheap, and the
// intended FIRST call of any import job — every blocker it reports is one
// that lets the migration appear to succeed while being quietly wrong
// (images still served by the old host, deploys that publish nothing).

import type { APIRoute } from 'astro';
import {
  buildCoreBlockRegistry,
  reviewBlockComposition,
  SITE_TEMPLATE_CAPABILITIES,
  type BlockType,
  type CompositionProposal,
} from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { runMigrationPreflight } from '../../../../../lib/migration-preflight';
import { vstore } from '../../../../../lib/version-store';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // ?source_url probes the site being migrated FROM as well: an old host
  // that 403s our requests produces empty imported pages, and that is worth
  // knowing before the content work, not during it.
  const sourceUrl = new URL(request.url).searchParams.get('source_url')?.trim() || undefined;
  const report = await runMigrationPreflight(ctx.orgId, ctx.siteId, ctx.versionId, { sourceUrl });
  return apiResponse(ctx, report);
};

interface PreflightBody {
  source_url?: unknown;
  compositions?: unknown;
}

function isCompositionProposal(value: unknown): value is CompositionProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<CompositionProposal>;
  return typeof proposal.name === 'string' && proposal.name.trim().length > 0 && Array.isArray(proposal.blocks);
}

/**
 * POST adds a read-only composition dependency review to the normal
 * infrastructure preflight. Migration agents use this before authoring so
 * generic CMS gaps become product work instead of tenant HTML/CSS debt.
 */
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as PreflightBody | null;
  if (!body) return apiError('Invalid JSON body');
  if (!Array.isArray(body.compositions) || body.compositions.length === 0) {
    return apiError('compositions must be a non-empty array');
  }
  if (body.compositions.length > 50) return apiError('Too many compositions (max 50)');
  if (!body.compositions.every(isCompositionProposal)) {
    return apiError('Each composition requires a non-empty name and blocks array');
  }
  if (body.source_url !== undefined && typeof body.source_url !== 'string') {
    return apiError('source_url must be a string');
  }

  const registry = buildCoreBlockRegistry();
  const customTypes = await vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId);
  for (const blockType of customTypes as BlockType[]) registry.set(blockType.id, blockType);

  const report = await runMigrationPreflight(ctx.orgId, ctx.siteId, ctx.versionId, {
    sourceUrl: body.source_url?.trim() || undefined,
  });
  const compositionReviews = body.compositions.map((proposal) => (
    reviewBlockComposition(proposal, registry)
  ));
  const compositionsReady = compositionReviews.every((review) => review.status === 'ready');

  return apiResponse(ctx, {
    ...report,
    ready: report.ready && compositionsReady,
    infrastructure_ready: report.ready,
    compositions_ready: compositionsReady,
    template_capabilities_version: SITE_TEMPLATE_CAPABILITIES.template_capabilities_version,
    composition_reviews: compositionReviews,
  });
};
