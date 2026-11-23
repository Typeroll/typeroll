import { checkPagesRedirects } from './pages-redirect-limits.mjs';
export const BULK_MARKER = '# typeroll-bulk-redirect-v1 ';
/** Read only exact, validated overflow rules; never accept executable output. */
export function pagesBulkRedirects(text) {
  const out = [], seen = new Set();
  checkPagesRedirects(text);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(BULK_MARKER)) continue;
    const value = JSON.parse(line.slice(BULK_MARKER.length));
    if (!value || typeof value.from_path !== 'string' || typeof value.to_path !== 'string' ||
      !value.from_path.startsWith('/') || value.from_path.startsWith('//') ||
      (value.from_path.includes('*') || /(^|\/):[A-Za-z_][A-Za-z0-9_]*(\/|$)/.test(value.from_path)) || value.from_path.includes('?') ||
      /[\s\x00-\x1f#\\]/.test(value.from_path) || /[\s\x00-\x1f\\]/.test(value.to_path) ||
      !/^(?:\/(?!\/)|https?:\/\/)/.test(value.to_path) || ![301, 302].includes(value.status_code) ||
      seen.has(value.from_path) || out.length >= 20000) throw new Error('Invalid static redirect overflow');
    checkPagesRedirects(`${value.from_path} ${value.to_path} ${value.status_code}`);
    seen.add(value.from_path);
    out.push({ from_path: value.from_path, to_path: value.to_path, status_code: value.status_code });
  }
  return out;
}
