import type { SiteSettings } from './types.js';

export type TrailingSlashPolicy = NonNullable<SiteSettings['trailing_slash']>;

/** Apply a site's canonical slash style without touching query/hash parts. */
export function applyTrailingSlash(path: string, policy: TrailingSlashPolicy = 'always'): string {
  const match = path.match(/^([^?#]*)([?#][\s\S]*)?$/);
  const pathname = match?.[1] || '/';
  const suffix = match?.[2] ?? '';
  if (pathname === '/') return `/${suffix}`;
  if (policy === 'always') return `${pathname.replace(/\/+$/, '')}/${suffix}`;
  if (policy === 'never') return `${pathname.replace(/\/+$/, '')}${suffix}`;
  return `${pathname}${suffix}`;
}
