// Cloudflare R2 + Image Resizing URL helpers.
//
// Originals live at:   https://cdn.example.com/sites/{siteId}/images/foo.jpg
// Optimized variant:   https://cdn.example.com/cdn-cgi/image/width=1200,quality=80,format=auto/sites/{siteId}/images/foo.jpg

export interface ImageOpts {
  width?: number;
  quality?: number;
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png';
  fit?: 'scale-down' | 'cover' | 'contain' | 'crop';
}

const CF_IMAGE_PREFIX = '/cdn-cgi/image';

export function optimizedUrl(cdnUrl: string, opts: ImageOpts = {}): string {
  if (!cdnUrl) return cdnUrl;
  // Don't try to rewrite non-CDN URLs (e.g. external <img> targets).
  let url: URL;
  try {
    url = new URL(cdnUrl);
  } catch {
    return cdnUrl;
  }
  const params = [
    opts.width && `width=${opts.width}`,
    `quality=${opts.quality ?? 85}`,
    `format=${opts.format ?? 'auto'}`,
    `fit=${opts.fit ?? 'scale-down'}`,
  ]
    .filter(Boolean)
    .join(',');
  return `${url.origin}${CF_IMAGE_PREFIX}/${params}${url.pathname}`;
}

export function srcSet(cdnUrl: string, widths = [400, 800, 1200, 1600]): string {
  return widths.map((w) => `${optimizedUrl(cdnUrl, { width: w })} ${w}w`).join(', ');
}
