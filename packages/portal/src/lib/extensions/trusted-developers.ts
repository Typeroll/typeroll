// App contracts (manifest `contract`) are reserved for trusted developer
// organizations: a contract component runs code and markup from the app's
// stable address on every site without a publication, and its default markup
// is written into pages unfiltered. The host decides who that may be.
//
// The list is a host setting rather than an operator-written document: it
// changes as rarely as the official apps do, a self-hosted portal sets it the
// same way as its other trust settings, and an empty or missing value fails
// closed (no organization may publish or run a contract release).

export const TRUSTED_APP_DEVELOPERS_ENV = 'TYPEROLL_TRUSTED_APP_DEVELOPER_ORGS';

/** Organization ids from the comma-separated host setting. */
export function trustedAppDeveloperOrgs(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env[TRUSTED_APP_DEVELOPERS_ENV] ?? '').split(',').map((id) => id.trim()).filter(Boolean));
}

export function isTrustedAppDeveloper(orgId: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(orgId) && trustedAppDeveloperOrgs(env).has(orgId!);
}
