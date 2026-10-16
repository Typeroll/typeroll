import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SelectedSite { organizationId: string; siteId: string; version: string }
const signature = (body: string, credential: string) => createHmac('sha256', credential).update(`typeroll-site-context-v1:${body}`).digest('base64url');

/** Not an authorization grant: live access is checked again on every request. */
export function issueSiteContext(site: SelectedSite, credential: string): string {
  const body = Buffer.from(JSON.stringify({ ...site, expires: Date.now() + 24 * 60 * 60 * 1000 })).toString('base64url');
  return `${body}.${signature(body, credential)}`;
}

export function verifySiteContext(token: string, credential: string): SelectedSite | null {
  if (token.length > 2048) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra) return null;
  const expected = signature(body, credential);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof data.expires !== 'number' || data.expires <= Date.now()) return null;
    if (![data.organizationId, data.siteId, data.version].every(value => typeof value === 'string' && value.length > 0)) return null;
    return { organizationId: data.organizationId, siteId: data.siteId, version: data.version };
  } catch { return null; }
}
