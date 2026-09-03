export const DEFAULT_IFRAME_ALLOWED_HOSTS = [
  'www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com',
  'player.vimeo.com', 'vimeo.com', 'www.google.com', 'maps.google.com', 'calendly.com',
] as const;

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize exact domain hostnames. Wildcards, IPs, ports, paths and credentials fail closed. */
export function normalizeIframeAllowedHosts(value: unknown): { hosts: string[]; invalid: string[] } {
  if (value === undefined || value === null) return { hosts: [], invalid: [] };
  if (!Array.isArray(value)) return { hosts: [], invalid: [String(value)] };
  const hosts = new Set<string>();
  const invalid: string[] = [];
  for (const entry of value) {
    const raw = typeof entry === 'string' ? entry.trim().toLowerCase().replace(/\.$/, '') : '';
    if (!DOMAIN_RE.test(raw)) {
      invalid.push(String(entry));
      continue;
    }
    try {
      const parsed = new URL(`https://${raw}`);
      if (parsed.hostname !== raw) throw new Error('invalid hostname');
      hosts.add(parsed.hostname);
    } catch {
      invalid.push(String(entry));
    }
  }
  return { hosts: [...hosts], invalid };
}
