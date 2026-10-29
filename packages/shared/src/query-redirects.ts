// Redirects whose source carries a query string, such as WordPress's
// `/?p=123`, `/?page_id=5` or `/index.php?cat=7`.
//
// Cloudflare Pages' `_redirects` matches the path only, and customer sites
// stay static, so these rules cannot become HTTP redirects. Instead the
// publication embeds them in the HTML document that answers the source path
// (or `404.html` when no page does), and a small inline script sends the
// visitor on with `location.replace`. Search engines follow such redirects,
// but they are not a 301; the documentation says so.

import type { Redirect } from './types.js';

export interface QueryRedirectSource {
  /** Literal path without trailing slash ("/" for the root). */
  path: string;
  /** Required parameters; every one must match exactly. */
  params: Array<[string, string]>;
}

const KEY_RE = /^[A-Za-z0-9_.\-[\]]+$/;

/** True when a redirect source carries a query string. */
export function isQueryRedirect(fromPath: string): boolean {
  return fromPath.includes('?');
}

/** Parse `/path?key=value&…`, or return an error the caller can show. */
export function parseQueryRedirectSource(fromPath: string): { ok: true; source: QueryRedirectSource } | { ok: false; error: string } {
  const index = fromPath.indexOf('?');
  if (index < 0) return { ok: false, error: 'from_path has no query string' };
  const rawPath = fromPath.slice(0, index) || '/';
  const query = fromPath.slice(index + 1);
  if (!rawPath.startsWith('/')) return { ok: false, error: 'from_path must start with "/"' };
  if (rawPath.includes('*') || /(^|\/):[A-Za-z_]/.test(rawPath)) {
    return { ok: false, error: 'a from_path with a query string must use a literal path, without * or :placeholders' };
  }
  if (!query) return { ok: false, error: 'from_path has an empty query string' };
  const params: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { ok: false, error: `query parameter "${part}" must be written as key=value` };
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
      value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return { ok: false, error: `query parameter "${part}" is not valid URL encoding` };
    }
    if (!KEY_RE.test(key)) return { ok: false, error: `query parameter name "${key}" is not supported` };
    if (!value) return { ok: false, error: `query parameter "${key}" needs a value` };
    if (seen.has(key)) return { ok: false, error: `query parameter "${key}" appears twice` };
    seen.add(key);
    params.push([key, value]);
  }
  return { ok: true, source: { path: normalizeQueryRedirectPath(rawPath), params } };
}

/**
 * True when `url` (path plus query) satisfies a query rule: the same path and
 * every required parameter with its exact value. Other parameters, such as
 * campaign tags, are ignored, as in the published script.
 */
export function queryRedirectMatches(fromPath: string, url: string): boolean {
  const rule = parseQueryRedirectSource(fromPath);
  if (!rule.ok) return false;
  const withoutHash = url.split('#', 1)[0];
  const index = withoutHash.indexOf('?');
  if (index < 0) return false;
  let path = withoutHash.slice(0, index) || '/';
  try { path = decodeURI(path); } catch { /* keep the raw path */ }
  if (normalizeQueryRedirectPath(path) !== rule.source.path) return false;
  const params = new URLSearchParams(withoutHash.slice(index + 1));
  return rule.source.params.every(([key, value]) => params.get(key) === value);
}

/** The comparison form of a path: no trailing slash or index.html, "/" for the root. */
export function normalizeQueryRedirectPath(pathname: string): string {
  const path = pathname.replace(/\/index\.html$/i, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : '/';
}

/**
 * Candidate files, relative to the build output, for a normalized path.
 * The first that exists answers the request; otherwise `404.html` does.
 */
export function queryRedirectDocumentCandidates(path: string): string[] {
  if (path === '/') return ['index.html'];
  const relative = path.replace(/^\/+/, '');
  return [`${relative}/index.html`, `${relative}.html`];
}

interface EmbeddedRule {
  p: string;
  q: Record<string, string>;
  t: string;
}

/** Group query rules by the normalized path that receives them, most specific first. */
export function groupQueryRedirects(redirects: Array<Pick<Redirect, 'from_path' | 'to_path'>>): Map<string, EmbeddedRule[]> {
  const parsed = redirects.flatMap((rule, order) => {
    if (!isQueryRedirect(rule.from_path)) return [];
    const result = parseQueryRedirectSource(rule.from_path);
    return result.ok ? [{ order, source: result.source, to: rule.to_path }] : [];
  });
  parsed.sort((a, b) => b.source.params.length - a.source.params.length || a.order - b.order);
  const groups = new Map<string, EmbeddedRule[]>();
  for (const { source, to } of parsed) {
    const list = groups.get(source.path) ?? [];
    list.push({ p: source.path, q: Object.fromEntries(source.params), t: to });
    groups.set(source.path, list);
  }
  return groups;
}

/** Inline script that redirects when the current path and query match a rule. */
export function queryRedirectScript(rules: EmbeddedRule[]): string {
  const data = JSON.stringify(rules).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script data-typeroll-query-redirects="1">(function(){var r=${data},s=new URLSearchParams(location.search),p=location.pathname.replace(/\\/index\\.html$/i,'/');p=p.length>1?(p.replace(/\\/+$/,'')||'/'):'/';try{p=decodeURI(p)}catch(e){}for(var i=0;i<r.length;i++){var x=r[i],ok=x.p===p;for(var k in x.q)if(ok&&s.get(k)!==x.q[k])ok=false;if(ok){location.replace(x.t);return}}})();</script>`;
}

/** Insert the script directly after `<head>`, so it runs before anything paints. */
export function injectQueryRedirectScript(html: string, rules: EmbeddedRule[]): string | null {
  if (!rules.length) return html;
  const match = /<head(\s[^>]*)?>/i.exec(html);
  if (!match) return null;
  const at = match.index + match[0].length;
  return html.slice(0, at) + queryRedirectScript(rules) + html.slice(at);
}

export interface QueryRedirectFiles {
  exists(relative: string): Promise<boolean>;
  read(relative: string): Promise<string>;
  write(relative: string, text: string): Promise<void>;
}

export interface QueryRedirectReport {
  /** Build-relative document and the number of rules embedded in it. */
  embedded: Array<{ file: string; rules: number }>;
  /** Paths whose rules found no document to carry them. */
  unplaced: string[];
}

/**
 * Embed every query-string rule in the built document that answers its
 * path, or in `404.html` when no page does. Run once per build output.
 */
export async function applyQueryRedirects(
  redirects: Array<Pick<Redirect, 'from_path' | 'to_path'>>,
  files: QueryRedirectFiles,
): Promise<QueryRedirectReport> {
  const report: QueryRedirectReport = { embedded: [], unplaced: [] };
  const byFile = new Map<string, EmbeddedRule[]>();
  for (const [path, rules] of groupQueryRedirects(redirects)) {
    let target: string | null = null;
    for (const candidate of queryRedirectDocumentCandidates(path)) {
      if (await files.exists(candidate)) { target = candidate; break; }
    }
    if (!target && await files.exists('404.html')) target = '404.html';
    if (!target) { report.unplaced.push(path); continue; }
    byFile.set(target, [...(byFile.get(target) ?? []), ...rules]);
  }
  for (const [file, rules] of byFile) {
    const html = injectQueryRedirectScript(await files.read(file), rules);
    if (html === null) { report.unplaced.push(...new Set(rules.map(rule => rule.p))); continue; }
    await files.write(file, html);
    report.embedded.push({ file, rules: rules.length });
  }
  return report;
}
