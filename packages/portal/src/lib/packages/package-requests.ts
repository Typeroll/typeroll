// Request parsing and error bodies shared by the package routes (session and v1).

import { PACKAGE_LIMITS } from '@typeroll/shared';
import { ConnectionError } from '../publishing/connections';
import { FontLibraryError } from '../fonts/font-library';
import { createSafeFetch, OutboundRequestError } from '../net/safe-fetch';
import { isRecord } from './package-common';
import { PackageError } from './package-zip';

/** A JSON body with data_base64 holds at most this much; larger packages come by source_url or upload. */
export const MAX_INLINE_PACKAGE_BYTES = 32 * 1024 * 1024;

/** A refused request as `{ status, body: { error, code, details? } }`, or null for an unexpected error. */
export function packageFailureBody(error: unknown): { status: number; body: { error: string; code?: string; details?: Record<string, unknown> } } | null {
  if (error instanceof PackageError || error instanceof FontLibraryError) {
    return { status: error.status, body: { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) } };
  }
  if (error instanceof ConnectionError) return { status: error.status, body: { error: error.message, code: error.code ?? 'package_storage_unavailable' } };
  return null;
}

const options = (raw: unknown): unknown => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { throw new PackageError('options must be JSON', 400, 'package_options_invalid'); }
};

/** The `file` (or `field`) and `options` (JSON) fields of a multipart upload. */
export async function packageUpload(request: Request, field = 'file'): Promise<{ bytes: Uint8Array; options: unknown }> {
  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > PACKAGE_LIMITS.zip_bytes + 1024 * 1024) throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
  let form: FormData;
  try { form = await request.formData(); } catch { throw new PackageError(`Send the package as multipart/form-data with the field "${field}"`, 400, 'package_invalid'); }
  const file = form.get(field);
  if (!file || typeof file === 'string') throw new PackageError(`Send the package as the multipart field "${field}"`, 400, 'package_invalid');
  if (file.size > PACKAGE_LIMITS.zip_bytes) throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
  return { bytes: new Uint8Array(await file.arrayBuffer()), options: options(form.get('options')) };
}

/** Fetch a package from a public https address, within the package size limit. */
export async function fetchPackageSource(sourceUrl: unknown, fetchImpl?: typeof fetch): Promise<Uint8Array> {
  let url: URL;
  try { url = new URL(String(sourceUrl)); } catch { throw new PackageError('source_url must be an https:// URL', 400, 'package_source_unavailable'); }
  if (url.protocol !== 'https:' || typeof sourceUrl !== 'string' || sourceUrl.length > 4096) throw new PackageError('source_url must be an https:// URL', 400, 'package_source_unavailable');
  const guarded = fetchImpl ?? createSafeFetch({ label: 'Package URL', maxRedirects: 3, timeoutMs: 60_000, maxBytes: PACKAGE_LIMITS.zip_bytes });
  try {
    const response = await guarded(url, { headers: { accept: 'application/vnd.typeroll.package+zip,application/zip;q=0.9,*/*;q=0.1' } });
    if (!response.ok) throw new PackageError(`The package URL answered ${response.status}`, 422, 'package_source_unavailable');
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof PackageError) throw error;
    if (error instanceof OutboundRequestError && error.code === 'response_too_large') throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
    throw new PackageError(`The package URL could not be read (${error instanceof Error ? error.message : 'unreachable'})`, 422, 'package_source_unavailable');
  }
}

/** The package bytes and options of a v1 JSON body: { data_base64 | source_url, options? }. */
export async function packageFromJson(request: Request, fetchImpl?: typeof fetch): Promise<{ bytes: Uint8Array; options: unknown }> {
  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > Math.ceil(MAX_INLINE_PACKAGE_BYTES / 3) * 4 + 1024 * 1024) {
    throw new PackageError(`A package sent as data_base64 may be at most ${MAX_INLINE_PACKAGE_BYTES / 1024 / 1024} MB; send a larger one as source_url`, 413, 'package_too_large');
  }
  const body = await request.json().catch(() => null);
  if (!isRecord(body)) throw new PackageError('Send a JSON object with data_base64 or source_url', 400, 'package_invalid');
  const unknown = Object.keys(body).filter(key => !['data_base64', 'source_url', 'options'].includes(key));
  if (unknown.length) throw new PackageError(`Unknown body keys: ${unknown.join(', ')}. Accepted keys: data_base64, source_url, options.`, 400, 'package_invalid');
  if ((body.data_base64 === undefined) === (body.source_url === undefined)) throw new PackageError('Send exactly one of data_base64 or source_url', 400, 'package_invalid');
  if (body.source_url !== undefined) return { bytes: await fetchPackageSource(body.source_url, fetchImpl), options: body.options };
  const value = body.data_base64;
  if (typeof value !== 'string' || !value) throw new PackageError('data_base64 must be the package file, base64-encoded', 400, 'package_invalid');
  const raw = (value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value).replace(/\s+/g, '');
  if (raw.length > Math.ceil(MAX_INLINE_PACKAGE_BYTES / 3) * 4 + 4) throw new PackageError(`A package sent as data_base64 may be at most ${MAX_INLINE_PACKAGE_BYTES / 1024 / 1024} MB; send a larger one as source_url`, 413, 'package_too_large');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw new PackageError('data_base64 is not valid base64', 400, 'package_invalid');
  return { bytes: new Uint8Array(Buffer.from(raw, 'base64')), options: body.options };
}
