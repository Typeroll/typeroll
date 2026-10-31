// Shared write-path guard for redirect rules.
//
// Three surfaces create redirects (v1 REST, the portal form, the chat AI)
// and each used to do its own `from_path.replace(...)` id derivation and no
// validation at all. That was survivable while every rule was a literal
// path. Wildcards change both halves:
//
//   - A malformed pattern is DROPPED SILENTLY by Cloudflare. It saves fine,
//     shows fine in the portal, and does nothing in production. Validation
//     has to happen at write time or it effectively never happens.
//   - A pattern can shadow LIVE PAGES — `/blogg/*` hides every article under
//     it, because Pages evaluates `_redirects` before serving static files.
//     The existing hygiene rule ("a real page always beats a redirect") is
//     enforced per-URL for literals; for a pattern it has to be enforced by
//     matching, and the honest place to do that is when the author writes
//     the rule and can still narrow it.
//
// The deploy runner keeps its belt-and-braces drop for anything that slips
// through (a page published after the rule was created).

import { createHash } from 'node:crypto';
import { paths, validateRedirectPattern, pagesShadowedByRedirect, isRedirectPattern, matchRedirect, sortRedirectsForEmit, contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';
import type { ContentType, Page, Redirect } from '@typeroll/shared';
import { vstore } from './version-store';
import { isLivePageStatus } from './redirect-hygiene';

export type RedirectWarning = { code: 'redirect_chain' | 'redirect_loop'; from_path: string; via: string[]; final_target: string };
export type RedirectWriteCheck = { ok: true; warnings?: RedirectWarning[] } | { ok: false; error: string };
export type RedirectWriteResult = { ok: true; id: string; action: 'create' | 'update'; warnings?: RedirectWarning[] } | { ok: false; error: string };

const MAX_REDIRECT_ID = 120;

/**
 * Doc id for a redirect. Patterns need distinct ids from the literal paths
 * they resemble: a naïve `[^a-zA-Z0-9._-] → _` mapping turns `/blogg/*` and
 * `/blogg/:slug` into the same id, so writing the second would silently
 * overwrite the first. A source too long for a readable id keeps a readable
 * prefix and gets a hash of the full path, so long paths that share their
 * first 120 characters (WordPress image size variants) stay distinct.
 */
export function redirectDocId(fromPath: string): string {
  const readable = readableRedirectId(fromPath);
  return readable && readable.length <= MAX_REDIRECT_ID ? readable : hashedRedirectDocId(fromPath);
}

const readableRedirectId = (fromPath: string) =>
  fromPath
    .replace(/^\//, '')
    .replace(/\?/g, '__q_')
    .replace(/&/g, '__and_')
    .replace(/=/g, '__eq_')
    .replace(/\*/g, '__splat')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '__p_$1')
    .replace(/[\/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');

function hashedRedirectDocId(fromPath: string): string {
  const hash = createHash('sha256').update(fromPath).digest('hex').slice(0, 16);
  const prefix = readableRedirectId(fromPath).slice(0, MAX_REDIRECT_ID - hash.length - 1).replace(/[-_.]+$/, '');
  return prefix ? `${prefix}-${hash}` : `r-${hash}`;
}

/**
 * The id a write of `fromPath` uses: the existing rule's id when the source
 * path already has one, otherwise a new id that no other source path owns.
 * The readable mapping is lossy (`/a/b` and `/a_b` share `a_b`), so an id
 * taken by another path falls back to the hashed form instead of replacing
 * that rule.
 */
export function assignRedirectDocId(fromPath: string, taken: ReadonlyMap<string, string>): { id: string; action: 'create' | 'update' } {
  for (const [id, owner] of taken) if (owner === fromPath) return { id, action: 'update' };
  for (const id of [redirectDocId(fromPath), hashedRedirectDocId(fromPath)]) {
    if (!taken.has(id)) return { id, action: 'create' };
  }
  throw new Error(`No free redirect id for ${fromPath}`);
}

const takenRedirectIds = (rules: Redirect[]) => new Map(rules.map(rule => [rule.id, rule.from_path]));

/**
 * Validate a redirect before it is written. Returns a caller-facing error
 * string, never throws.
 */
export async function checkRedirectWrite(args: {
  orgId: string;
  siteId: string;
  versionId: string;
  from_path: string;
  to_path: string;
}): Promise<RedirectWriteResult> {
  const syntax = checkRedirectSyntax(args.from_path, args.to_path);
  if (!syntax.ok) return syntax;
  const context = await loadRedirectWriteContext(args.orgId, args.siteId, args.versionId);
  const shadow = checkRedirectShadow(context, args.from_path, args.to_path);
  if (!shadow.ok) return shadow;
  const warnings = redirectChainWarnings([...context.existing.filter(rule => rule.from_path !== args.from_path), { id:'candidate', from_path:args.from_path, to_path:args.to_path, status_code:301 }]);
  if (createsLoop(warnings, args.from_path)) return { ok: false, error: 'Invalid redirect: this rule creates a redirect loop.' };
  const { id, action } = assignRedirectDocId(args.from_path, takenRedirectIds(context.existing));
  return { ok: true, id, action, ...(warnings.length ? { warnings } : {}) };
}

export type RedirectWriteContext = { liveUrls: string[]; existing: Redirect[] };

/** Read the pages, content types and rules a redirect write is checked against. */
export async function loadRedirectWriteContext(orgId: string, siteId: string, versionId: string): Promise<RedirectWriteContext> {
  // Resolve URLs exactly as the renderer does: the content type's route
  // template places a page, and types without a route have no public URL.
  const [pages, contentTypes, existing] = await Promise.all([
    vstore.pages(orgId, siteId, versionId),
    vstore.contentTypes(orgId, siteId, versionId),
    vstore.redirects(orgId, siteId, versionId),
  ]);
  const types = new Map<string, ContentType>([[DEFAULT_CONTENT_TYPE.id, DEFAULT_CONTENT_TYPE], ...contentTypes.map((type) => [type.id, type] as [string, ContentType])]);
  const liveUrls = pages
    .filter((p: Page) => isLivePageStatus(p.status))
    .flatMap((p: Page) => {
      const type = types.get(p.content_type ?? 'page');
      const url = type ? contentPagePath(p, type) : null;
      return url ? [url] : [];
    });
  return { liveUrls, existing };
}

function checkRedirectSyntax(from_path: string, to_path: string): RedirectWriteCheck {
  const syntax = validateRedirectPattern(from_path, to_path);
  if (!syntax.ok) {
    return { ok: false, error: `Invalid redirect: ${syntax.error}` };
  }
  if (!to_path.startsWith('/') && !/^https?:\/\//.test(to_path)) {
    return { ok: false, error: 'Invalid redirect: to_path must be a site-relative path ("/x") or an absolute http(s) URL' };
  }
  const normalize = (value: string) => value.replace(/\/+$/, '').toLowerCase() || '/';
  if (!isRedirectPattern(from_path) && to_path.startsWith('/') && normalize(from_path) === normalize(to_path))
    return { ok: false, error: 'Invalid redirect: source and destination are the same normalized path. Use the site trailing-slash policy instead.' };
  return { ok: true };
}

function checkRedirectShadow(context: RedirectWriteContext, from_path: string, to_path: string): RedirectWriteCheck {
  const shadowed = pagesShadowedByRedirect(from_path, to_path, context.liveUrls);
  if (!shadowed.length) return { ok: true };
  const list = shadowed.slice(0, 8).join(', ') + (shadowed.length > 8 ? `, +${shadowed.length - 8} more` : '');
  return {
    ok: false,
    error:
      `This rule would hide ${shadowed.length} live page(s): ${list}. ` +
      'Cloudflare Pages applies redirects before serving files, so the page would become unreachable. ' +
      (isRedirectPattern(from_path)
        ? 'Narrow the pattern (a deeper prefix), or unpublish the page(s) if the redirect is what you want.'
        : 'Delete or unpublish the page first if the redirect is what you want.'),
  };
}

const createsLoop = (warnings: RedirectWarning[], fromPath: string) =>
  warnings.some(warning => warning.code === 'redirect_loop' && warning.via.includes(fromPath));

export type RedirectBatchRule = { from_path: string; to_path: string; status_code: 301 | 302 };
export type RedirectBatchResult = {
  from_path: string;
  id: string;
  action: 'create' | 'update' | 'unchanged';
  ok: boolean;
  error?: string;
};

/**
 * Check a set of upserts as one change: each rule is validated against the
 * site's pages and against every other rule as it will be after the batch,
 * so a loop formed inside the batch is caught before anything is written.
 */
export function checkRedirectBatch(context: RedirectWriteContext, rules: RedirectBatchRule[]): { results: RedirectBatchResult[]; warnings: RedirectWarning[] } {
  const byFrom = new Map(context.existing.map(rule => [rule.from_path, rule]));
  // Ids are reserved in batch order, so two new rules never share one either.
  const taken = takenRedirectIds(context.existing);
  const ids = rules.map(rule => {
    const { id } = assignRedirectDocId(rule.from_path, taken);
    taken.set(id, rule.from_path);
    return id;
  });
  const merged = new Map(byFrom);
  rules.forEach((rule, index) => merged.set(rule.from_path, { ...(byFrom.get(rule.from_path) ?? {}), id: ids[index]!, ...rule }));
  const warnings = redirectChainWarnings([...merged.values()]);
  const results = rules.map<RedirectBatchResult>((rule, index) => {
    const current = byFrom.get(rule.from_path);
    const id = ids[index]!;
    const action = !current ? 'create' : current.to_path === rule.to_path && current.status_code === rule.status_code ? 'unchanged' : 'update';
    const check = [checkRedirectSyntax(rule.from_path, rule.to_path), checkRedirectShadow(context, rule.from_path, rule.to_path)].find(result => !result.ok);
    if (check && !check.ok) return { from_path: rule.from_path, id, action, ok: false, error: check.error };
    if (createsLoop(warnings, rule.from_path)) return { from_path: rule.from_path, id, action, ok: false, error: 'Invalid redirect: this rule creates a redirect loop.' };
    return { from_path: rule.from_path, id, action, ok: true };
  });
  return { results, warnings };
}

/** Check literal entry paths through the same ordered rules used at publication. */
export function redirectChainWarnings(rules: Redirect[]): RedirectWarning[] {
  const ordered = sortRedirectsForEmit(rules);
  return rules.filter(rule => !isRedirectPattern(rule.from_path)).flatMap<RedirectWarning>(rule => {
    let path = rule.from_path;
    const via: string[] = [], seen = new Set<string>();
    for (let hop = 0; hop < 16; hop++) {
      if (seen.has(path)) return [{ code:'redirect_loop' as const, from_path:rule.from_path, via, final_target:path }];
      seen.add(path);
      const target = ordered.map(candidate => matchRedirect(candidate.from_path, candidate.to_path, path)).find(value => value !== null);
      if (target == null) break;
      via.push(path); path = target;
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) break;
    }
    return via.length > 1 ? [{ code:'redirect_chain' as const, from_path:rule.from_path, via, final_target:path }] : [];
  });
}
