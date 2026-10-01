// Normalization for site settings fields that the portal settings form and the
// public API (PATCH /api/v1/sites/{siteId}/settings, MCP update_site_settings)
// both accept. Kept in one place so the two doors store the same shapes.

import type { SiteSettings } from '@typeroll/shared';

export type OrganizationSettings = NonNullable<SiteSettings['organization']>;

/** `@acme` and `acme` are the same handle; the renderer adds the `@`. */
export function normalizeTwitterHandle(value: string): string | undefined {
  return value.trim().replace(/^@/, '') || undefined;
}

/** Trailing slashes are dropped; an empty value clears the staging URL. */
export function normalizeStagingUrl(value: string): string | null {
  return value.trim().replace(/\/+$/, '') || null;
}

/**
 * Organization JSON-LD. Empty strings and blank `same_as` entries are dropped;
 * an organization with nothing left is `undefined`, which clears it.
 */
export function normalizeOrganization(input: {
  name?: string;
  logo?: string;
  same_as?: string[];
}): OrganizationSettings | undefined {
  const name = (input.name ?? '').trim();
  const logo = (input.logo ?? '').trim();
  const sameAs = (input.same_as ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (!name && !logo && sameAs.length === 0) return undefined;
  return { name: name || undefined, logo: logo || undefined, same_as: sameAs };
}

/**
 * Validate an API `organization` value. Returns the error message, or the
 * normalized organization (`undefined` clears it). `null` and `{}` clear.
 */
export function parseOrganizationInput(
  value: unknown,
): { ok: true; organization: OrganizationSettings | undefined } | { ok: false; error: string } {
  if (value === null) return { ok: true, organization: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'organization must be an object with name, logo and same_as, or null' };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !['name', 'logo', 'same_as'].includes(key));
  if (unknownKeys.length) return { ok: false, error: `Unknown organization fields: ${unknownKeys.join(', ')}` };
  for (const key of ['name', 'logo'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      return { ok: false, error: `organization.${key} must be a string` };
    }
  }
  if (record.same_as !== undefined
    && (!Array.isArray(record.same_as) || record.same_as.some((entry) => typeof entry !== 'string'))) {
    return { ok: false, error: 'organization.same_as must be an array of URL strings' };
  }
  return {
    ok: true,
    organization: normalizeOrganization({
      name: record.name as string | undefined,
      logo: record.logo as string | undefined,
      same_as: record.same_as as string[] | undefined,
    }),
  };
}
