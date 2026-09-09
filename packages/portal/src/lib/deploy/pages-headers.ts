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

/** Pages indexes rules by pattern; repeated patterns discard earlier headers. */
export function withGlobalHeaders(input: string, headers: Record<string, string>): string {
  const rules = new Map<string, string[]>();
  let pattern = '';
  for (const line of input.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { pattern = line.trim(); if (!rules.has(pattern)) rules.set(pattern, []); }
    else if (pattern) rules.get(pattern)!.push(line);
  }
  const names = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  const global = (rules.get('/*') ?? []).filter(line => !names.has(line.trim().split(':', 1)[0]!.toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || !value || /[\r\n]/.test(value)) throw new Error('Invalid publication header');
    global.push(`  ${name}: ${value}`);
  }
  rules.set('/*', global);
  return [...rules].map(([path, values]) => [path, ...values, ''].join('\n')).join('\n');
}

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
