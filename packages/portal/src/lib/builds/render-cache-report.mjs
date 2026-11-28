const choices = {
  read: ['hit', 'missing', 'invalid', 'too_large', 'format_mismatch', 'read_failed', 'forced'],
  save: ['saved', 'partial', 'empty', 'write_failed'],
  encoding: ['gzip', 'json'],
  transfer: ['not_supplied', 'downloaded', 'download_failed', 'integrity_failed'],
  transfer_reason: ['pointer_missing', 'account_changed', 'pointer_invalid', 'grant_failed', 'object_missing', 'http_error', 'storage_unavailable', 'integrity_failed'],
  storage: ['uploaded', 'upload_failed', 'not_saved', 'pointer_failed'],
};
/** Fixed labels and bounded numbers only; paths, URLs and errors never leave the runner. */
export function renderCacheReport(value) {
  if (!value || typeof value !== 'object') return undefined;
  /** @type {Record<string, any>} */
  const result = {};
  for (const [name, allowed] of Object.entries(choices)) if (allowed.includes(value[name])) result[name] = value[name];
  for (const name of ['read_bytes', 'stored_bytes', 'decoded_bytes', 'retained_routes', 'omitted_routes'])
    if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= 256 * 1024 * 1024) result[name] = value[name];
  if (Array.isArray(value.invalidations)) result.invalidations = value.invalidations.filter(reason =>
    ['renderer_changed', 'global_inputs_changed', 'runtime_changed', 'legacy_identity'].includes(reason)).slice(0, 4);
  if (value.inputs && ['renderer', 'globals', 'environment'].every(name => /^[a-f0-9]{64}$/.test(value.inputs[name])))
    result.inputs = Object.fromEntries(['renderer', 'globals', 'environment'].map(name => [name, value.inputs[name]]));
  return Object.keys(result).length ? result : undefined;
}
