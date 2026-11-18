import { createHash } from 'node:crypto';
import type { PreviewTicket } from './preview-signing';

export type PreviewScope = Pick<PreviewTicket, 'org_id' | 'site_id' | 'version_id'>;

/** Operator-owned wildcard origin, never a customer-controlled setting. */
export function previewOriginConfig(env: NodeJS.ProcessEnv = process.env): { template: string; portal: string; suffix: string } | null {
  const template = env.PREVIEW_ORIGIN_TEMPLATE?.trim();
  if (!template) return null;
  if (template.split('{scope}').length !== 2) throw new Error('PREVIEW_ORIGIN_TEMPLATE must contain one {scope} hostname label');
  // A fixed suffix keeps environments on distinct first-level hosts covered
  // by a single wildcard certificate. The scope must remain the first label.
  if (!/^https?:\/\/\{scope\}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\./.test(template)) throw new Error('Invalid isolated preview origin template');
  const sample = new URL(template.replace('{scope}', 'preview-scope'));
  const label = sample.hostname.split('.')[0];
  if (label.length - 'preview-scope'.length + 32 > 63) throw new Error('Preview scope hostname label is too long');
  const portal = new URL(env.PORTAL_PUBLIC_URL ?? '');
  const local = sample.hostname.endsWith('.localhost') && (portal.hostname === 'localhost' || portal.hostname === '127.0.0.1' || portal.hostname.endsWith('.localhost'));
  if ((!['https:', ...(local ? ['http:'] : [])].includes(sample.protocol) || !['https:', ...(local ? ['http:'] : [])].includes(portal.protocol)) || sample.username || sample.password || sample.pathname !== '/' || sample.search || sample.hash) throw new Error('Invalid isolated preview origin template');
  const suffix = sample.hostname.slice(label.length + 1);
  // Fail closed for a shared cookie domain. Operators must use a separate
  // registrable domain, not a sibling of the portal. This conservative check
  // also refuses shared public suffixes such as co.uk; choose a distinct base.
  if (!local && (portal.hostname.split('.').slice(-2).join('.') === suffix.split('.').slice(-2).join('.'))) throw new Error('Preview and portal must use separate cookie domains');
  return { template: template.replace(/\/$/, ''), portal: portal.origin, suffix };
}

export function isolatedPreviewOrigin(scope: PreviewScope): string | null {
  const config = previewOriginConfig();
  if (!config) return null;
  const label = createHash('sha256').update(JSON.stringify([scope.org_id, scope.site_id, scope.version_id])).digest('hex').slice(0, 32);
  return new URL(config.template.replace('{scope}', label)).origin;
}

/** Matches the entire reserved domain, including malformed/unassigned hosts. */
export function isPreviewHost(url: URL): boolean {
  const config = previewOriginConfig();
  return !!config && (url.hostname === config.suffix || url.hostname.endsWith(`.${config.suffix}`));
}

export function matchesPreviewOrigin(request: Request, scope: PreviewScope): boolean {
  const origin = isolatedPreviewOrigin(scope);
  return !!origin && new URL(request.url).origin === origin;
}

export function previewUrlOrigin(scope: PreviewScope, fallback: string): string {
  return isolatedPreviewOrigin(scope) ?? fallback;
}

/** Do not expose login, session APIs, writes, or application assets on this host. */
export function previewHostAllows(request: Request): boolean {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const path = new URL(request.url).pathname;
  return /^\/preview\/[^/]+(?:\/|$)/.test(path) || /^\/api\/preview-fonts\/[^/]+\//.test(path);
}

export function realOriginPreviewHeaders(): Record<string, string> {
  const config = previewOriginConfig();
  if (!config) throw new Error('Isolated preview origin is not configured');
  return {
    'Content-Security-Policy': `sandbox allow-scripts allow-forms allow-popups allow-same-origin; frame-ancestors 'self' ${config.portal}; object-src 'none'; worker-src 'none'; base-uri 'none'`,
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  };
}
