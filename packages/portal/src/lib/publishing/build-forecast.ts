import { getStore } from '../datastore';
import { renderCachePath, type RenderCachePointer } from '../builds/state';
import { buildStorage } from '../builds/storage';
import { MAX_RENDER_CACHE_BYTES } from '../builds/contract.mjs';
import { currentPublicationRendererDigest } from './source-tree';
import type { PublicationImpact } from './impact';

export interface BuildForecast {
  mode: 'full' | 'automatic' | 'unknown';
  reasons: string[];
  cache: 'available' | 'missing' | 'expired' | 'unavailable' | 'too_large';
  stored_bytes?: number;
  /** Validates availability/renderer identity, never the per-route dependency graph. */
  reuse_verified: false;
}
const GLOBAL_KINDS = new Set(['partial', 'menu', 'template', 'block_type', 'content_type', 'form']);
const GLOBAL_CONFIGURATION = new Set(['site', 'settings', 'apps', 'runtime_dependencies', 'extensions', 'impact_origins']);

/** A scoped read-only prediction. No rendered HTML is downloaded or trusted here. */
async function readForecast(orgId: string, siteId: string, versionId: string, impact: PublicationImpact): Promise<BuildForecast> {
  const result = (mode: BuildForecast['mode'], cache: BuildForecast['cache'], reasons: string[], stored_bytes?: number): BuildForecast =>
    ({ mode, cache, reasons, reuse_verified: false, ...(stored_bytes !== undefined ? { stored_bytes } : {}) });
  try {
    const pointer = await getStore().getDoc<RenderCachePointer>(renderCachePath({ org_id: orgId, site_id: siteId, version_id: versionId }));
    if (!pointer) return result('full', 'missing', ['cache_missing']);
    if (!Number.isSafeInteger(pointer.created_at) || pointer.created_at <= 0 || !/^[a-f0-9]{64}$/.test(pointer.key) || !/^[a-f0-9-]{36}$/.test(pointer.lease) || !/^[a-f0-9]{64}$/.test(pointer.sha256))
      return result('unknown', 'unavailable', ['cache_pointer_invalid']);
    if (Date.now() - pointer.created_at >= 7 * 24 * 60 * 60_000) return result('full', 'expired', ['cache_expired']);
    const head = await buildStorage(orgId, async storage => {
      if (storage.account !== pointer.account) return null;
      return storage.head(`builds/${orgId}/tasks/${pointer.key}/${pointer.lease}/render-cache.json`);
    });
    if (!head) return result('full', 'unavailable', ['cache_account_changed']);
    if (head.bytes === 0) return result('full', 'available', ['cache_empty'], 0);
    if (head.bytes > MAX_RENDER_CACHE_BYTES) return result('full', 'too_large', ['cache_too_large'], head.bytes);
    if (!pointer.diagnostics?.inputs?.renderer) return result('unknown', 'available', ['cache_metadata_unavailable'], head.bytes);
    if (pointer.diagnostics.retained_routes === 0) return result('full', 'available', ['cache_empty'], head.bytes);
    if (pointer.diagnostics.inputs.renderer !== await currentPublicationRendererDigest()) return result('full', 'available', ['renderer_changed'], head.bytes);
    if (!impact.changes_known || impact.total > impact.changes.length) return result('unknown', 'available', ['source_changes_not_fully_compared'], head.bytes);
    if (impact.changes.some(change => GLOBAL_KINDS.has(change.kind) || change.kind === 'configuration' && GLOBAL_CONFIGURATION.has(change.id)))
      return result('full', 'available', ['global_inputs_changed'], head.bytes);
    return result('automatic', 'available', ['route_dependencies_checked_during_build'], head.bytes);
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return status === 404 ? result('full', 'missing', ['cache_object_missing']) : result('unknown', 'unavailable', ['cache_check_unavailable']);
  }
}

/** Provider outages must not hold the source-impact screen indefinitely. */
export async function forecastPublicationBuild(orgId: string, siteId: string, versionId: string, impact: PublicationImpact): Promise<BuildForecast> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readForecast(orgId, siteId, versionId, impact),
      new Promise<BuildForecast>(resolve => { timer = setTimeout(() => resolve({ mode: 'unknown', cache: 'unavailable', reasons: ['cache_check_timeout'], reuse_verified: false }), 4000); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
