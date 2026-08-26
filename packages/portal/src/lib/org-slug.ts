// Org slug generation helpers. Extracted as pure functions so they're
// testable without touching Firestore.

/**
 * Turn a human name into a URL-safe org slug.
 * Rules: lowercase, replace whitespace + non-alphanumeric runs with `-`,
 * strip leading/trailing hyphens, max 48 chars.
 */
export function slugifyOrgName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Given a base slug and a set of already-taken slugs, return a unique slug
 * by appending a numeric suffix (e.g. `acme-corp-2`, `acme-corp-3`).
 * If the base slug itself isn't taken it is returned unchanged.
 */
export function resolveUniqueSlug(base: string, takenSlugs: ReadonlySet<string>): string {
  if (!takenSlugs.has(base)) return base;
  for (let i = 2; i <= 9999; i++) {
    const candidate = `${base}-${i}`;
    if (!takenSlugs.has(candidate)) return candidate;
  }
  // Extremely unlikely — just append a random suffix as last resort.
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
