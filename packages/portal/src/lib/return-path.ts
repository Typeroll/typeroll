/**
 * A portal path to return to after signing in, or null. Only application
 * pages on this origin are accepted, so a crafted link cannot send a person
 * to another site after authentication.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/app/') || /[\\\x00-\x1f]/.test(value)) return null;
  try {
    const base = 'https://portal.invalid';
    const url = new URL(value, base);
    if (url.origin !== base || !url.pathname.startsWith('/app/')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
