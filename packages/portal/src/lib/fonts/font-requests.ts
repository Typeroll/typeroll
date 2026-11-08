// Request parsing shared by the Fonts library routes (session and v1).

import { MAX_FONT_UPLOAD_BYTES } from '@typeroll/shared';
import { FontLibraryError } from './font-library';

const tooLarge = () => new FontLibraryError(`The font file is larger than ${MAX_FONT_UPLOAD_BYTES / 1024 / 1024} MB`, 413, 'font_too_large');

/** Refuse a body that cannot hold an acceptable upload before reading it. */
export function checkUploadLength(request: Request, encodedFactor = 1): void {
  const length = Number(request.headers.get('content-length') ?? '');
  // Room for the multipart envelope or the JSON around base64 data.
  if (Number.isFinite(length) && length > MAX_FONT_UPLOAD_BYTES * encodedFactor + 64 * 1024) throw tooLarge();
}

/** The file part of a multipart upload, read whole. */
export async function uploadedFile(form: FormData): Promise<{ bytes: Uint8Array; filename: string }> {
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new FontLibraryError('Send the font as the multipart field "file"', 400, 'font_details_invalid');
  if (file.size > MAX_FONT_UPLOAD_BYTES) throw tooLarge();
  if (file.size === 0) throw new FontLibraryError('The font file is empty', 422, 'font_invalid');
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name || 'font' };
}

/** Multipart form data, or a clear refusal. */
export async function uploadForm(request: Request): Promise<FormData> {
  checkUploadLength(request);
  try { return await request.formData(); } catch { throw new FontLibraryError('Send the font as multipart/form-data with the field "file"', 400, 'font_details_invalid'); }
}

/** A form field as text; absent and empty are undefined. */
export const formText = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/** Decode `data_base64` (a data: URL prefix is allowed). */
export function decodeBase64Font(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value) throw new FontLibraryError('data_base64 must be the font file, base64-encoded', 400, 'font_details_invalid');
  const raw = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  if (raw.length > Math.ceil(MAX_FONT_UPLOAD_BYTES / 3) * 4 + 4) throw tooLarge();
  if (!/^[A-Za-z0-9+/_-]*={0,2}\s*$/.test(raw.replace(/\s+/g, ''))) throw new FontLibraryError('data_base64 is not valid base64', 400, 'font_details_invalid');
  const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
  if (!bytes.byteLength) throw new FontLibraryError('data_base64 decoded to zero bytes', 422, 'font_invalid');
  return bytes;
}
