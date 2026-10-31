/**
 * `target` and `rel` attributes for an authored link. Only word-like rel tokens
 * survive; a new tab always adds noopener and noreferrer.
 */
export function linkTargetAttributes(rawRel: unknown, newTab: unknown): string {
  const rel = new Set(String(typeof rawRel === 'string' ? rawRel : '').split(/\s+/).filter(token => /^[a-z][a-z0-9_-]*$/i.test(token)).map(token => token.toLowerCase()));
  if (newTab === true) { rel.add('noopener'); rel.add('noreferrer'); }
  return `${newTab === true ? ' target="_blank"' : ''}${rel.size ? ` rel="${[...rel].join(' ')}"` : ''}`;
}
