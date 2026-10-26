import { Parser } from 'htmlparser2';
import { fetchPublicAsset, parsePublicHttpsUrl } from '../extensions/public-http';

/** Bounded, read-only discovery. Public REST cannot prove private types or old-slug completeness. */
export async function discoverPublicWordPress(origin: string, options: {
  crawlPages?: number; maxRequests?: number; read?: (url: string) => Promise<string>;
} = {}) {
  const base = parsePublicHttpsUrl(origin).origin;
  const read = options.read ?? (async url => new TextDecoder().decode(await fetchPublicAsset(url, 2_000_000, fetch, { 'User-Agent':'Typeroll-Migration-Inventory/1.0' })));
  const limit = Math.min(50, Math.max(1, options.maxRequests ?? 30));
  const deadline = Date.now() + 45_000;
  let requests = 0, truncated = false;
  const warnings: string[] = [], urls = new Set<string>();
  const get = async (url: string) => {
    if (requests >= limit || Date.now() > deadline) { truncated = true; throw Error('Discovery limit reached'); }
    if (new URL(url).origin !== base) throw Error('Discovery must stay on the source origin');
    requests++; return read(url);
  };
  const add = (raw: string, relative = base) => {
    try {
      const url = new URL(raw, relative); url.hash = '';
      if (url.origin === base && !url.username && !url.password && urls.size < 5000) urls.add(url.href);
      else if (urls.size >= 5000) truncated = true;
    } catch { /* Not a public URL. */ }
  };
  const endpoints = new Set(['pages','posts']);
  try {
    const types = JSON.parse(await get(`${base}/wp-json/wp/v2/types`));
    for (const type of Object.values(types) as Array<{rest_base?:string;rest_namespace?:string}>) {
      if ((!type.rest_namespace || type.rest_namespace === 'wp/v2') && /^[a-z0-9_-]+$/i.test(type.rest_base ?? '') && type.rest_base !== 'media') endpoints.add(type.rest_base!);
    }
  } catch { warnings.push('Public type discovery unavailable; trying pages and posts. Private types and old slugs require an authoritative export.'); }
  for (const endpoint of endpoints) {
    if (truncated) break;
    for (let page = 1; page <= 20; page++) {
      try {
        const rows = JSON.parse(await get(`${base}/wp-json/wp/v2/${endpoint}?per_page=100&page=${page}&_fields=link`));
        if (!Array.isArray(rows)) throw Error('Unexpected REST response');
        for (const row of rows) if (typeof row.link === 'string') add(row.link);
        if (rows.length < 100) break;
        if (page === 20) truncated = true;
      } catch { warnings.push(`Could not finish public REST inventory for ${endpoint}, page ${page}. Review the source or use the helper export.`); break; }
    }
  }
  add('/');
  const queued = [...urls];
  const crawlLimit = Math.min(50, Math.max(0, options.crawlPages ?? 0));
  for (let i = 0; i < queued.length && i < crawlLimit && !truncated; i++) {
    try {
      const html = await get(queued[i]);
      const parser = new Parser({ onopentag(name, attrs) {
        if (name !== 'a' || !attrs.href) return;
        const before = urls.size; add(attrs.href, queued[i]);
        if (urls.size > before) queued.push([...urls].at(-1)!);
      } }, { decodeEntities: true });
      parser.end(html);
    } catch { warnings.push(`Could not crawl ${queued[i]}; access restrictions or redirects require separate review.`); }
  }
  return { urls:[...urls], requests, truncated, warnings,
    coverage: 'Public REST and bounded same-origin links only. Not proof of all historical URLs, hidden content types or private content.' };
}
