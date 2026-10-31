// GET  /api/v1/sites/{siteId}/redirects
// POST /api/v1/sites/{siteId}/redirects   create, or update the rule with the same from_path
// PUT  /api/v1/sites/{siteId}/redirects   upsert many rules at once, optionally as a dry run

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { getStore } from '../../../../../../lib/datastore';
import { paths, pagesRedirectCapacity } from '@typeroll/shared';
import { checkRedirectBatch, checkRedirectWrite, loadRedirectWriteContext } from '../../../../../../lib/redirect-write';
import type { RedirectBatchRule } from '../../../../../../lib/redirect-write';

/** One call stays well inside Cloudflare Pages' 2,100-rule limit per site. */
const MAX_BATCH = 1000;

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const items = await vstore.redirects(ctx.orgId, ctx.siteId, ctx.versionId);
  return apiResponse(ctx, {
    redirects: items.map((r) => ({
      id: r.id,
      from_path: r.from_path,
      to_path: r.to_path,
      status_code: r.status_code,
      auto_generated: r.auto_generated,
    })),
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as {
    from_path?: string;
    to_path?: string;
    status_code?: number;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  const from_path = (body.from_path ?? '').trim();
  const to_path = (body.to_path ?? '').trim();
  if (!from_path || !to_path) return apiError('from_path and to_path required');
  const status_code = (body.status_code === 302 ? 302 : 301) as 301 | 302;
  const check = await checkRedirectWrite({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, from_path, to_path,
  });
  if (!check.ok) return apiError(check.error);
  // The same source path always means the same rule and keeps its id; a new
  // source path never takes an id that another rule owns.
  const { id, action } = check;
  await getStore().setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`, {
    from_path,
    to_path,
    status_code,
    auto_generated: false,
  });
  return apiResponse(ctx, { action, redirect: { id, from_path, to_path, status_code }, warnings: check.warnings ?? [] }, 201, body);
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as { redirects?: unknown; dry_run?: unknown } | null;
  if (!body || !Array.isArray(body.redirects)) return apiError('redirects must be an array of { from_path, to_path, status_code }');
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return apiError('dry_run must be a boolean');
  if (!body.redirects.length) return apiError('redirects must not be empty');
  if (body.redirects.length > MAX_BATCH) return apiError(`At most ${MAX_BATCH} redirects per request`);
  const rules: RedirectBatchRule[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of body.redirects.entries()) {
    const item = raw as { from_path?: unknown; to_path?: unknown; status_code?: unknown } | null;
    if (!item || typeof item.from_path !== 'string' || typeof item.to_path !== 'string' || !item.from_path.trim() || !item.to_path.trim())
      return apiError(`redirects[${index}] needs from_path and to_path`);
    if (item.status_code !== undefined && item.status_code !== 301 && item.status_code !== 302)
      return apiError(`redirects[${index}].status_code must be 301 or 302`);
    const from_path = item.from_path.trim();
    if (seen.has(from_path)) return apiError(`redirects[${index}] repeats from_path ${from_path}`);
    seen.add(from_path);
    rules.push({ from_path, to_path: item.to_path.trim(), status_code: item.status_code === 302 ? 302 : 301 });
  }
  const context = await loadRedirectWriteContext(ctx.orgId, ctx.siteId, ctx.versionId);
  const { results, warnings } = checkRedirectBatch(context, rules);
  const failed = results.filter((result) => !result.ok);
  const summary = {
    create: results.filter((result) => result.action === 'create').length,
    update: results.filter((result) => result.action === 'update').length,
    unchanged: results.filter((result) => result.action === 'unchanged').length,
    failed: failed.length,
  };
  const dryRun = body.dry_run === true;
  // Cloudflare Pages caps a site's _redirects file; report the rules this batch
  // would leave, so an inventory over the cap is seen before publishing fails.
  const merged = new Map(context.existing.map((rule) => [rule.from_path, rule]));
  for (const rule of rules) merged.set(rule.from_path, { ...(merged.get(rule.from_path) ?? {}), ...rule } as any);
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
  const counted = pagesRedirectCapacity([...merged.values()], { trailing_slash: settings?.trailing_slash });
  const capacityWarning = counted.over_limit ? `After this batch the site emits ${counted.static} static and ${counted.dynamic} dynamic redirect rules (with slash aliases); Cloudflare Pages allows ${counted.limit_static} and ${counted.limit_dynamic}, so publishing will fail with publication_redirect_limit. Consolidate rules, or point old file addresses at fewer targets.`
    : counted.remaining_static < 100 ? `After this batch only ${counted.remaining_static} of ${counted.limit_static} static redirect rules remain; publication also adds media replacement rules.` : null;
  const capacity = { ...counted, ...(capacityWarning ? { warning: capacityWarning } : {}) };
  // All or nothing: a batch with one invalid rule writes none of them.
  if (dryRun || failed.length) {
    return apiResponse(ctx, {
      ...(failed.length && !dryRun ? { error: `${failed.length} redirect(s) failed validation; nothing was written.` } : {}),
      dry_run: dryRun, applied: false, summary, capacity, results, warnings,
    }, failed.length && !dryRun ? 422 : 200, body);
  }
  const existing = new Map(context.existing.map((rule) => [rule.from_path, rule]));
  const writes = rules.flatMap((rule, index) => {
    const result = results[index]!;
    if (result.action === 'unchanged') return [];
    const { id: _id, ...stored } = existing.get(rule.from_path) ?? {};
    return [{ path: `${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${result.id}`, data: { ...stored, ...rule, auto_generated: false } }];
  });
  // Each rule is replaced in place, so no source path is ever without a rule.
  for (let start = 0; start < writes.length; start += 20) {
    await Promise.all(writes.slice(start, start + 20).map((write) => getStore().setDoc(write.path, write.data)));
  }
  return apiResponse(ctx, { dry_run: false, applied: true, summary, capacity, results, warnings }, 200, body);
};
