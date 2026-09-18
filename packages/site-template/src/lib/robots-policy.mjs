/** Product tokens, not HTTP User-Agent substrings. Google documents the
 * Googlebot fallback for Google-InspectionTool. This is policy inspection,
 * never evidence of a successful request from a verified crawler.
 * https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers
 */
export function robotsAllows(source, pathname, product = 'Googlebot') {
  const groups = []; let group, hasRules = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const separator = line.indexOf(':'); if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase(), value = line.slice(separator + 1).trim();
    if (name === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [] }; groups.push(group); hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(name)) { hasRules = true; if (value) group.rules.push({ allow: name === 'allow', path: value }); }
  }
  const tokens = product.toLowerCase() === 'google-inspectiontool' ? ['google-inspectiontool', 'googlebot', '*'] : [product.toLowerCase(), '*'];
  const token = tokens.find(token => groups.some(group => group.agents.includes(token)));
  let winner = null;
  for (const rule of groups.filter(group => group.agents.includes(token)).flatMap(group => group.rules)) {
    const anchored = rule.path.endsWith('$');
    const pattern = (anchored ? rule.path.slice(0, -1) : rule.path).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (!new RegExp('^' + pattern + (anchored ? '$' : '')).test(pathname)) continue;
    const length = rule.path.replace(/[*$]/g, '').length;
    if (!winner || length > winner.length || length === winner.length && rule.allow) winner = { ...rule, length };
  }
  return winner?.allow ?? true;
}
