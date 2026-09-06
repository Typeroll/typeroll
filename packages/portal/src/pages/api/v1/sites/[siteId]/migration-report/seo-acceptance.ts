import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { MigrationSeoAcceptance } from '../../../../../../lib/migration-launch-report';

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<MigrationSeoAcceptance> | null;
  if (!body) return apiError('Invalid JSON body');
  if (body.status !== 'accepted' && body.status !== 'rejected') return apiError('status must be accepted or rejected');
  if (!validDate(body.checked_at)) return apiError('checked_at must be an ISO timestamp');
  if (!body.dataset?.trim()) return apiError('dataset is required');
  if (!isHttpOrigin(body.source_origin) || !isHttpOrigin(body.target_origin)) {
    return apiError('source_origin and target_origin must be absolute http(s) origins');
  }
  if (!positiveInteger(body.checked_pages)) return apiError('checked_pages must be a positive integer');
  const differences = body.differences;
  if (!differences || !nonNegativeInteger(differences.total)
    || !nonNegativeInteger(differences.intentional) || !nonNegativeInteger(differences.unresolved)
    || differences.intentional + differences.unresolved > differences.total) {
    return apiError('differences must contain valid total, intentional and unresolved counts');
  }
  if (body.status === 'accepted' && differences.unresolved !== 0) {
    return apiError('accepted evidence cannot have unresolved differences');
  }
  const evidence: MigrationSeoAcceptance = {
    status: body.status,
    checked_at: new Date(body.checked_at!).toISOString(),
    recorded_at: new Date().toISOString(),
    dataset: body.dataset.trim(),
    source_origin: new URL(body.source_origin!).origin,
    target_origin: new URL(body.target_origin!).origin,
    checked_pages: body.checked_pages!,
    differences,
    ...(body.notes?.trim() ? { notes: body.notes.trim() } : {}),
  };
  const store = getStore();
  const deploys = await store.listDocs<{
    id: string;
    version_id: string;
    status: string;
    dry_run?: boolean;
    started_at: string;
    finished_at?: string;
  }>(paths.deploys(ctx.orgId, ctx.siteId));
  const latestDeploy = deploys
    .filter((job) => job.version_id === ctx.versionId && job.status === 'succeeded'
      && job.dry_run !== true && job.finished_at)
    .sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at))[0];
  if (!latestDeploy?.finished_at) {
    return apiError('A successful hosted deploy is required before SEO acceptance can be recorded', 409);
  }
  if (evidence.checked_at < latestDeploy.finished_at) {
    return apiError('checked_at must be at or after the latest successful hosted deploy', 409);
  }
  evidence.deployment_job_id = latestDeploy.id;
  evidence.deployment_finished_at = latestDeploy.finished_at;
  await store.setDoc(
    paths.migrationSeoAcceptance(ctx.orgId, ctx.siteId, ctx.versionId),
    evidence as unknown as Record<string, unknown>,
  );
  return apiResponse(ctx, { evidence }, 200, body);
};

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
