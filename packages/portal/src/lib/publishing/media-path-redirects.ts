import { createHash } from 'node:crypto';
import { pagesRedirectCapacity, pagesShadowedByRedirect, type Redirect } from '@typeroll/shared';
import { mediaRedirectLivePaths } from './media-redirect-policy';

/**
 * A configured old uploads address declares the migration namespace. Freeze
 * its path-preserving mapping, retaining every explicit exception and all
 * authored rows in storage. Nothing is inferred from hashed filenames.
 */
export function mediaPathRedirects(publication: Record<string, any>, rules: Redirect[], previous: any[] = []) {
  const manifest = publication.media_manifest;
  if (!manifest?.entries?.length) return { redirects: rules, generated: [] as Redirect[] };
  const generatedIds = new Set((publication.media_path_redirects ?? []).map((rule: Redirect) => rule.id));
  const ids = new Set(rules.map(rule => rule.id));
  rules = [...rules, ...(publication.media_redirect_omissions ?? []).filter((rule: Redirect) => !ids.has(rule.id))]
    .filter(rule => !generatedIds.has(rule.id));
  const origin = new URL(publication.site_url).origin;
  const entries = new Map<string, any>(manifest.entries.map((entry: any) => [`${entry.id}:${entry.sha256}`, entry]));
  const canonical = new Map<string, string>();
  const add = (address: string, target: string) => {
    try { canonical.set(new URL(address, origin).href, target); } catch { /* Invalid history never authorizes a new route. */ }
  };
  for (const entry of manifest.entries) {
    for (const address of [entry.cdn_url, ...(entry.aliases ?? []).map((alias: any) => alias.url), ...(entry.legacy_urls ?? [])]) add(address, entry.cdn_url);
  }
  for (const earlier of previous) for (const old of earlier.entries ?? []) {
    const entry = entries.get(`${old.id}:${old.sha256}`);
    if (!entry) continue;
    for (const address of [old.cdn_url, ...(old.aliases ?? []).map((alias: any) => alias.url)]) {
      add(address, entry.cdn_url);
      try {
        const parsed = new URL(address);
        if (parsed.hostname === earlier.website_host) add(parsed.pathname, entry.cdn_url);
      } catch { /* Only verified website paths authorize relative target updates. */ }
    }
  }
  const redirects = rules.map(rule => {
    try {
      const target = canonical.get(new URL(rule.to_path, origin).href);
      return target ? { ...rule, to_path: target } : rule;
    } catch { return rule; }
  });
  const declared = new Set<string>();
  for (const entry of manifest.entries) {
    const wp = entry.wordpress_upload;
    if (wp && (wp.declared || redirects.some(rule => rule.from_path === wp.source_path && rule.to_path === entry.cdn_url))) declared.add(wp.prefix);
  }
  const generated: Redirect[] = [];
  const make = (from_path: string, to_path: string, status_code: 301 | 302 = 301): Redirect => ({
    id: `media-path-${createHash('sha256').update(from_path).digest('hex').slice(0, 32)}`, from_path, to_path, status_code,
  });
  for (const prefix of [...declared].sort()) {
    const from = `${prefix}/*`;
    const target = `https://${manifest.media_host}${manifest.media_path_prefix}/:splat`;
    const existing = redirects.find(rule => rule.from_path === from);
    // A configured namespace rule remains an explicit routing decision.
    if (existing && existing.to_path !== target) continue;
    const candidate = make(from, target);
    const capacity = pagesRedirectCapacity([...redirects, ...generated, candidate], publication.settings);
    const live = mediaRedirectLivePaths(publication);
    const exactOnly = !live || pagesShadowedByRedirect(from, target, live).length > 0 ||
      (!existing && capacity.dynamic + (publication.site?.domain && publication.site?.domain_alias ? 1 : 0) > capacity.limit_dynamic);
    if (!existing && !exactOnly) generated.push(candidate);
    for (const entry of manifest.entries) {
      const wp = entry.wordpress_upload;
      if (wp?.prefix !== prefix || rules.some(rule => rule.from_path === wp.source_path)) continue;
      const expected = new URL(target.replace(':splat', wp.source_path.slice(prefix.length + 1))).href;
      if (exactOnly || expected !== entry.cdn_url) generated.push(make(wp.source_path, entry.cdn_url, existing?.status_code));
    }
  }
  return { redirects: [...redirects, ...generated], generated };
}
