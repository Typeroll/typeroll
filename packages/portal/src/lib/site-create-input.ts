// Fields a new site accepts at creation, shared by POST /api/v1/sites and the
// create-and-migrate / create-and-plan routes. Unknown fields are refused by
// name rather than dropped: a caller that sends `language` and gets a 201 has
// no way to learn that the site was created in English.

/** Site language tags, as `PATCH /api/v1/sites/{siteId}` accepts them. */
const SITE_LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
/** Site ids and slugs: 3-48 lowercase characters, kebab-case. */
export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** Static portal and API segments beside `sites/{siteId}`. */
const RESERVED_SITE_IDS = new Set(['new', 'create', 'create-and-migrate', 'create-and-plan']);

export const SITE_LANGUAGE_ERROR = 'language must be a BCP-47 tag (e.g. "en", "sv", "en-GB")';

/** A site language tag; '' clears it, `error` when it is not a tag. */
export function parseSiteLanguage(value: unknown): { language: string; error?: undefined } | { error: string } {
  const language = String(value).trim();
  if (language && !SITE_LANGUAGE_RE.test(language)) return { error: SITE_LANGUAGE_ERROR };
  return { language };
}

/** The requested id of a new site, or `error` when it cannot be one. */
export function parseNewSiteId(value: unknown): { id: string; error?: undefined } | { error: string } {
  if (typeof value !== 'string' || !SITE_ID_RE.test(value.trim())) {
    return { error: 'id must be 3-48 lowercase letters, digits and "-", starting and ending with a letter or digit (e.g. "acme-studio")' };
  }
  const id = value.trim();
  if (RESERVED_SITE_IDS.has(id)) return { error: `id "${id}" is reserved; choose another id` };
  return { id };
}

/** Message naming the fields a body may not carry, or null when all are known. */
export function unknownFieldsError(body: Record<string, unknown>, accepted: readonly string[]): string | null {
  const unknown = Object.keys(body).filter(key => !accepted.includes(key));
  if (!unknown.length) return null;
  return `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Accepted fields: ${accepted.join(', ')}.`;
}

/** Optional `id` and `language` of a new site; `error` names the field. */
export function parseNewSiteOptions(body: Record<string, unknown>): { id?: string; language?: string; error?: undefined } | { error: string } {
  const out: { id?: string; language?: string } = {};
  if (body.id !== undefined && body.id !== null) {
    const parsed = parseNewSiteId(body.id);
    if (parsed.error !== undefined) return { error: parsed.error };
    out.id = parsed.id;
  }
  if (body.language !== undefined && body.language !== null) {
    const parsed = parseSiteLanguage(body.language);
    if (parsed.error !== undefined) return { error: parsed.error };
    if (parsed.language) out.language = parsed.language;
  }
  return out;
}

/** The requested site id exists in the organization already. */
export class SiteIdTakenError extends Error {
  readonly code = 'site_id_taken';
  constructor(readonly siteId: string) {
    super(`A site with id "${siteId}" already exists in this organization. Choose another id, or omit id to derive one from name.`);
  }
}
