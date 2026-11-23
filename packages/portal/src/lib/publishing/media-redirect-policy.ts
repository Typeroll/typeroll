import { contentPagePath, DEFAULT_CONTENT_TYPE, expandRedirectsForTrailingSlashPolicy, isQueryRedirect, isRedirectPattern, matchRedirect, pagesShadowedByRedirect, type ContentType, type Page, type Redirect, type TrailingSlashPolicy } from '@typeroll/shared';

// Ambiguous, encoded and non-file paths keep their exact rules. Never infer
// an entire source namespace from the finite set of imported file names.
const literalFile = (path: string) => /^\/[A-Za-z0-9._~/-]+\.[A-Za-z0-9]{1,12}$/.test(path)
  && !path.includes('//') && !path.split('/').some(segment => segment === '.' || segment === '..');

/** Preserve authored rules; compact only the copy frozen for a publication. */
export function compactCoveredMediaRedirects<T extends Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>>(rules: T[], policy: TrailingSlashPolicy = 'always', livePageUrls: Iterable<string> = []): T[] {
  const paths = rules.filter(rule => !isQueryRedirect(rule.from_path));
  const allPatterns = paths.filter(rule => isRedirectPattern(rule.from_path));
  // The shared coverage matcher collapses empty path segments. Such a source
  // is not sufficient proof of equivalent provider routing.
  if (allPatterns.some(rule => rule.from_path.includes('//'))) return rules;
  const live = [...livePageUrls];
  // The renderer drops a pattern that shadows any built HTML page. It cannot
  // provide fallback coverage for another file in that namespace.
  const patterns = allPatterns.filter(rule => !pagesShadowedByRedirect(rule.from_path, rule.to_path, live).length);
  if (!patterns.length) return rules;
  // Include generated base aliases as well as patterns. Once a literal is
  // absent, one of those aliases can become the first matching Pages line.
  const fallback = expandRedirectsForTrailingSlashPolicy(patterns, policy);
  const emitted = new Map(expandRedirectsForTrailingSlashPolicy(paths, policy).map(rule => [rule.from_path, rule]));
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.from_path, (counts.get(rule.from_path) ?? 0) + 1);
  const compact = rules.filter(rule => {
    if (!literalFile(rule.from_path) || counts.get(rule.from_path) !== 1) return true;
    const expected = emitted.get(rule.from_path);
    if (!expected) return true;
    for (const candidate of fallback) {
      const target = isRedirectPattern(candidate.from_path) ? matchRedirect(candidate.from_path, candidate.to_path, rule.from_path)
        : candidate.from_path === rule.from_path ? candidate.to_path : null;
      if (target !== null) return target !== expected.to_path || candidate.status_code !== expected.status_code;
    }
    return true;
  });
  return compact.length === rules.length ? rules : compact;
}

/** Keep omitted rows in routing history for domain-only republications. */
export function freezeMediaRedirects<T extends Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>>(rules: T[], policy?: TrailingSlashPolicy, publication: { pages?: Page[]; contentTypes?: ContentType[]; blockTypes?: unknown[]; pageTemplates?: unknown[] } = {}) {
  const paginated = (value: unknown): boolean => !!value && typeof value === 'object' && Object.entries(value).some(([key, entry]) =>
    (key === 'paginate' && typeof entry === 'number' && entry > 0) || paginated(entry));
  // Facets and pagination add routes after freezing. Without their complete
  // rendered inventory, retain exact mappings rather than assume coverage.
  if (publication.contentTypes?.some(type => type.facets?.length) || paginated({ pages: publication.pages, blockTypes: publication.blockTypes, pageTemplates: publication.pageTemplates })) return { redirects: rules, omitted: [] as T[] };
  const types = new Map([[DEFAULT_CONTENT_TYPE.id, DEFAULT_CONTENT_TYPE], ...(publication.contentTypes ?? []).map(type => [type.id, type] as const)]);
  const live = ['/', ...(publication.pages ?? []).flatMap(page => {
    const type = types.get(page.content_type ?? 'page');
    const url = type && contentPagePath(page, type);
    return url ? [url] : [];
  })];
  const redirects = compactCoveredMediaRedirects(rules, policy, live), kept = new Set(redirects);
  return { redirects, omitted: rules.filter(rule => !kept.has(rule)) };
}
