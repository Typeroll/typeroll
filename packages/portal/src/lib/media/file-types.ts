// Media filename extensions must agree with the media type.
//
// Static hosts such as Cloudflare Pages choose a file's Content-Type from its
// extension, not from the type recorded at upload. When media is delivered
// from the website host, a PNG upload named `x.html` (or a public_path ending
// in .svg, .xml or .js) would be served as a document in the website's
// origin. Every place that sets a media filename or public_path therefore
// accepts only the extensions listed for the record's type, and the
// publication manifest refuses or renames records that do not match.
//
// This module has no Node or framework imports beyond ConnectionError.

import { ConnectionError } from '../publishing/connections';

/** Canonical extension first. Every listed extension is served as a passive type. */
export const MEDIA_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/jpg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/pjpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/x-png': ['png'],
  'image/apng': ['apng', 'png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  // Only sanitized SVG may be published (lib/media/svg-media.ts).
  'image/svg+xml': ['svg'],
  'image/x-icon': ['ico'],
  'image/vnd.microsoft.icon': ['ico'],
  'image/bmp': ['bmp'],
  'image/x-ms-bmp': ['bmp'],
  'image/tiff': ['tif', 'tiff'],
  'image/heic': ['heic'],
  'image/heif': ['heif', 'heic'],
  'image/jxl': ['jxl'],
  'application/pdf': ['pdf'],
  // Uploads accept image/* and application/pdf only (routes and
  // createMediaUpload). The rest are listed so existing records stay publishable.
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/ogg': ['ogg', 'oga'],
  'font/woff': ['woff'],
  'font/woff2': ['woff2'],
  // Publishing serves a record of any other type as a download (lib/publishing/media-manifest.ts).
  'application/octet-stream': ['bin'],
});

export const SVG_MEDIA_TYPE = 'image/svg+xml';

/** Browsers render image/svg+xml, and any other XML media type, as a document that can run script. */
export function isScriptableMediaType(type: string | null | undefined): boolean {
  const essence = mediaTypeEssence(type);
  return essence === SVG_MEDIA_TYPE || essence.endsWith('+xml') || essence === 'text/xml' || essence === 'application/xml';
}

/** Static hosts choose Content-Type from the file extension, so an .svg name needs the same treatment as the SVG type. */
export function requiresSvgSanitization(media: { mime_type?: string | null; filename?: string | null }): boolean {
  return isScriptableMediaType(media.mime_type) || /\.(?:svgz?|xml|xht|xhtml)$/i.test(media.filename ?? '');
}

export function mediaTypeEssence(type: string | null | undefined): string {
  return (type ?? '').split(';')[0].trim().toLowerCase();
}

/** Allowed extensions for a type; empty for a type this server does not publish. */
export function allowedMediaExtensions(type: string | null | undefined): readonly string[] {
  return MEDIA_EXTENSIONS[mediaTypeEssence(type)] ?? [];
}

/**
 * The passive type a static host serves for this name, for records whose own
 * type is missing or unknown. SVG is excluded: it is published only sanitized.
 */
export function passiveTypeForName(name: string): string | null {
  const extension = mediaExtension(name);
  const type = extension ? Object.keys(MEDIA_EXTENSIONS).find(candidate => MEDIA_EXTENSIONS[candidate].includes(extension)) : undefined;
  if (!type || type === SVG_MEDIA_TYPE || type === 'application/octet-stream' || !mediaNameMatchesType(name, type)) return null;
  return type;
}

/** Lower-case extension of the last path segment, or null when there is none. */
export function mediaExtension(name: string): string | null {
  const segment = name.split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot < 0 || dot === segment.length - 1) return null;
  return segment.slice(dot + 1).toLowerCase();
}

/** True when `name` (a filename or a public path) ends in an extension allowed for `type`. */
export function mediaNameMatchesType(name: string, type: string | null | undefined): boolean {
  const allowed = allowedMediaExtensions(type);
  const names = [name];
  // A percent-encoded extension must not differ from what a host decodes.
  try { const decoded = decodeURIComponent(name); if (decoded !== name) names.push(decoded); } catch { return false; }
  return names.every(value => { const extension = mediaExtension(value); return !!extension && allowed.includes(extension); });
}

function describe(type: string | null | undefined): string {
  const allowed = allowedMediaExtensions(type);
  return allowed.length ? allowed.map(extension => `.${extension}`).join(', ') : 'none';
}

/** 400 when a filename or public path does not end in an extension allowed for the media type. */
export function assertMediaName(name: string, type: string | null | undefined, field: 'filename' | 'public_path' = 'filename'): void {
  if (!allowedMediaExtensions(type).length) {
    throw new ConnectionError(`Media of type ${mediaTypeEssence(type) || 'unknown'} cannot be published. Upload an image or PDF.`, 415, 'media_type_unsupported');
  }
  if (!mediaNameMatchesType(name, type)) {
    throw new ConnectionError(`The ${field} must end in an extension that matches the file type ${mediaTypeEssence(type)} (${describe(type)}).`, 400, 'media_extension_mismatch');
  }
}

/**
 * For names derived from a source URL rather than chosen by a person: keep a
 * matching name, otherwise append the canonical extension. Unknown types throw.
 */
export function withMediaExtension(name: string, type: string | null | undefined): string {
  const allowed = allowedMediaExtensions(type);
  if (!allowed.length) assertMediaName(name, type);
  return mediaNameMatchesType(name, type) ? name : `${name}.${allowed[0]}`;
}

/**
 * PATCH/PUT of a media record: a changed filename or public_path must match
 * the stored type. Unchanged values pass, so legacy records stay editable.
 */
export function assertMediaNameUpdate(existing: { mime_type?: string | null; filename?: string | null; public_path?: string | null },
  update: Record<string, unknown>): void {
  if (update.filename !== undefined && update.filename !== existing.filename) {
    if (typeof update.filename !== 'string' || !update.filename.trim() || update.filename.length > 255) {
      throw new ConnectionError('Enter a filename of at most 255 characters.', 400, 'invalid_filename');
    }
    assertMediaName(update.filename, existing.mime_type, 'filename');
  }
  if (typeof update.public_path === 'string' && update.public_path !== existing.public_path) {
    assertMediaName(update.public_path, existing.mime_type, 'public_path');
  }
}
