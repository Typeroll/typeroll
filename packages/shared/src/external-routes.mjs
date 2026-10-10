/** Exact same-origin paths owned by an independent deployment, not a skip list. */
export function externalRoutesError(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1000) return 'external_routes must contain at most 1000 exact paths with an owner';
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const fail = detail => `external_routes.${index}: ${detail}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['path', 'owner'].includes(key))) return fail('use path and owner only');
    if (typeof entry.owner !== 'string' || !entry.owner.trim() || entry.owner.length > 200 || /[\x00-\x1f\x7f]/.test(entry.owner)) return fail('owner must name the independent deployment (1–200 characters)');
    const p = entry.path;
    if (typeof p !== 'string' || p.length > 2048 || !p.startsWith('/') || p.startsWith('//') || /[\\*?#\s\x00-\x1f\x7f]/.test(p)) return fail('path must be an exact absolute URL path, without wildcard, query or fragment');
    let parsed;
    try { parsed = new URL(p, 'https://routes.invalid'); decodeURIComponent(p); } catch { return fail('invalid URL path'); }
    if (parsed.pathname !== p || /%(?:2e|2f|5c|25)/i.test(p) || p.includes('//')) return fail('use a normalized path without encoded separators or dot segments');
    if (p === '/' || /^\/(?:index\.html|404(?:\.html)?|robots\.txt|sitemap[^/]*\.xml|_headers|_redirects)\/?$/i.test(p)) return fail('the root deployment owns this reserved path');
    const identity = p.replace(/\/index\.html$/, '/').replace(/\/$/, '');
    if (seen.has(identity)) return fail('duplicate path or trailing-slash alias');
    seen.add(identity);
  }
  return null;
}
