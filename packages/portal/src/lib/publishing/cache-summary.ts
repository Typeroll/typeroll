import type { DeployJob } from '@typeroll/shared';
import type { BuildForecast } from './build-forecast';

export function cacheSummary(cache: NonNullable<DeployJob['render_report']>['cache']): string {
  if (!cache) return '';
  const messages: string[] = [];
  if (cache.read === 'missing') messages.push('No previous render cache was available.');
  if (cache.read === 'too_large') messages.push('The previous render cache exceeded its size limit.');
  if (cache.read === 'invalid' || cache.read === 'format_mismatch') messages.push('The previous render cache was incompatible or invalid.');
  if (cache.invalidations?.includes('renderer_changed')) messages.push('Rendering code or dependencies changed.');
  if (cache.invalidations?.includes('global_inputs_changed')) messages.push('Shared rendering inputs changed.');
  if (cache.invalidations?.includes('runtime_changed')) messages.push('The build environment changed.');
  if (cache.transfer === 'download_failed' || cache.transfer === 'integrity_failed') messages.push('The previous render cache could not be transferred and verified.');
  if (cache.save === 'partial') messages.push(`The cache keeps ${cache.retained_routes ?? 0} routes; ${cache.omitted_routes ?? 0} routes exceeded its budget and will render again.`);
  if (cache.save === 'write_failed' || cache.storage === 'upload_failed' || cache.storage === 'pointer_failed') messages.push('The build succeeded, but its render cache could not be saved for the next build.');
  if (cache.save === 'saved' && cache.storage === 'uploaded') messages.push(`Render cache saved for ${cache.retained_routes ?? 0} routes.`);
  return messages.join(' ');
}
export function forecastSummary(forecast: BuildForecast): string {
  if (forecast.mode === 'automatic') return 'Build forecast: compatible render cache is available. The build checks each route before reusing it.';
  if (forecast.mode === 'unknown') return 'Build forecast: cache reuse cannot be determined yet. The build reports the actual result.';
  const reason = forecast.reasons[0];
  const detail: Record<string, string> = { cache_missing: 'no previous render cache', cache_object_missing: 'the cache file is missing', cache_expired: 'the cache expired',
    cache_too_large: 'the cache exceeds its size limit', cache_empty: 'the cache has no retained routes', cache_account_changed: 'the storage account changed',
    renderer_changed: 'rendering code or dependencies changed', global_inputs_changed: 'shared rendering inputs changed' };
  return `Build forecast: full HTML render (${detail[reason] ?? 'no reusable baseline'}).`;
}
