const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTPS, or plain HTTP only to a loopback host where the key never leaves the machine. */
export function isSecureApiUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * Validate TYPEROLL_API_URL before an API key is attached to any request.
 * Returns an error message, or null when the URL is acceptable.
 */
export function apiUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'TYPEROLL_API_URL must be an absolute URL such as https://app.typeroll.com.'; }
  if (url.username || url.password) return 'TYPEROLL_API_URL must not contain credentials.';
  if (!isSecureApiUrl(url)) return 'TYPEROLL_API_URL must use HTTPS (HTTP is allowed only for localhost, 127.0.0.1 or [::1]).';
  return null;
}
