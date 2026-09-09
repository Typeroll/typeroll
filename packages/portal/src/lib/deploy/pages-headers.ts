const BASE_HEADERS = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '  Cache-Control: public, max-age=300, must-revalidate, no-transform',
  '',
  '/_astro/*',
  '  Cache-Control: public, max-age=31536000, immutable, no-transform',
  '',
  '/_assets/*',
  '  Cache-Control: public, max-age=31536000, immutable, no-transform',
  '',
  '/sitemap.xml',
  '  Cache-Control: public, max-age=3600, no-transform',
  '/sitemap-images.xml',
  '  Cache-Control: public, max-age=3600, no-transform',
  '/robots.txt',
  '  Cache-Control: public, max-age=3600, no-transform',
  '',
];

function normalizeBaseDomain(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes('://') ||
    hostname.includes('/') ||
    hostname.includes(':') ||
    !hostname.includes('.') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    throw new Error(`Invalid SITES_BASE_DOMAIN: ${value}`);
  }
  return hostname;
}

/**
 * Build the Cloudflare Pages `_headers` file for a customer site.
 *
 * Hosted installations add an absolute host pattern for the platform-owned
 * fallback namespace. The same build can therefore stay indexable on its
 * customer domain while every fallback alias receives a response-level
 * noindex directive. Self-hosted installs without SITES_BASE_DOMAIN keep only
 * the portable route-based defaults.
 */
export function buildPagesHeaders(baseDomain?: string): string {
  const lines = [...BASE_HEADERS];
  if (baseDomain?.trim()) {
    const hostname = normalizeBaseDomain(baseDomain);
    lines.push(
      `https://:site.${hostname}/*`,
      '  X-Robots-Tag: noindex, nofollow',
      '',
    );
  }
  return lines.join('\n');
}
