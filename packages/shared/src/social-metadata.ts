import type { ContentType, Page, SiteSettings } from './types.js';
import { ogLocale } from './defaults.js';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Share images social networks render (Facebook, LinkedIn, X, Slack). SVG and AVIF are not among them. */
export const SOCIAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** The size Typeroll renders a non-raster share image at, and the large-card size networks recommend. */
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;
/** Below this width networks fall back to a small card or no image. */
export const SHARE_IMAGE_MIN_WIDTH = 600;

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic',
};

/** The image type from a media type, else from the URL's extension; '' when unknown. */
export function shareImageType(url: string, mimeType?: string): string {
  const essence = text(mimeType).split(';')[0]!.trim().toLowerCase();
  if (essence) return essence;
  let pathname = url;
  try { pathname = new URL(url, 'https://example.invalid').pathname; } catch { /* keep the raw value */ }
  const extension = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXTENSION_TYPES[extension] ?? '';
}

export function isSocialImageType(type: string): boolean {
  return (SOCIAL_IMAGE_TYPES as readonly string[]).includes(type);
}

export interface ShareImageIssue {
  code: 'missing' | 'unsupported_format' | 'too_small' | 'unknown_size';
  message: string;
}

/**
 * Problems with a share image as networks see it. A missing image is the
 * caller's to classify (a suggestion, not an error). Width and height come
 * from the Media record when known.
 */
export function shareImageIssues(url: string | undefined | null, meta: { mime_type?: string; width?: number; height?: number } = {}): ShareImageIssue[] {
  const value = text(url);
  if (!value) return [{ code: 'missing', message: 'No share image is set. Pages are shared without a picture.' }];
  const type = shareImageType(value, meta.mime_type);
  if (type && !isSocialImageType(type)) {
    return [{ code: 'unsupported_format', message: `The share image is ${type}, which Facebook, LinkedIn, X and Slack do not show. Published sites get a ${SHARE_IMAGE_WIDTH}×${SHARE_IMAGE_HEIGHT} PNG copy when the file is in the site's media library; otherwise choose a PNG or JPEG.` }];
  }
  if (!meta.width || !meta.height) return [{ code: 'unknown_size', message: 'The share image size is unknown. Use an image from the media library so its size can be checked.' }];
  if (meta.width < SHARE_IMAGE_MIN_WIDTH) {
    return [{ code: 'too_small', message: `The share image is ${meta.width} px wide. Networks show a large card from ${SHARE_IMAGE_MIN_WIDTH} px; ${SHARE_IMAGE_WIDTH}×${SHARE_IMAGE_HEIGHT} is recommended.` }];
  }
  return [];
}
/** Resolve sharing metadata from public content only, without storing derived mirrors. */
export function socialMetadata(page: Page, settings: SiteSettings, type?: ContentType, pageUrl?: string) {
  const field = type?.fields.find(field => field.rendered !== false && type.schema_field_map?.[field.name] === 'image' && text(page.fields?.[field.name]));
  const mappedImage = field ? text(page.fields?.[field.name]) : '';
  const altField = field && type?.fields.find(candidate => candidate.name === `${field.name}_alt` && candidate.rendered !== false);
  const mappedAlt = altField ? text(page.fields?.[altField.name]) : '';
  const baseTitle = text(page.seo_title) || page.title;
  const suffix = settings.default_seo_suffix || '';
  const documentTitle = page.append_seo_suffix === false || !suffix || baseTitle.endsWith(suffix) ? baseTitle : baseTitle + suffix;
  const explicitImage = text(page.og_image);
  const selectedImage = explicitImage || mappedImage || settings.default_og_image || settings.logo || '';
  let image = selectedImage;
  if (selectedImage && pageUrl) {
    try { const url = new URL(selectedImage, pageUrl); image = /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch { image = ''; }
  }
  const bodyAlt = page.html_content?.match(/<img\b[^>]*\balt=["']([^"']*)["']/i)?.[1] || '';
  return {
    type: page.kind === 'article' || ['Article', 'BlogPosting', 'NewsArticle'].includes(page.schema_type || type?.schema_type || '') ? 'article' : 'website',
    title: text(page.og_title) || documentTitle,
    description: text(page.og_description) || text(page.seo_description) || settings.default_meta_description || settings.tagline || '',
    image,
    imageAlt: text(page.seo_image_alt) || (!explicitImage && mappedImage ? mappedAlt : bodyAlt),
    locale: ogLocale(page.language || settings.language),
  };
}
