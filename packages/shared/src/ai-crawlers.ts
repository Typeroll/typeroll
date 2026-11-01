// AI crawler policy: one site setting, expressed the way Cloudflare and the
// Content Signals Policy (https://contentsignals.org) express it, so a site's
// robots.txt, its `Content-Signal` response header and a Cloudflare zone's
// managed directives use the same vocabulary.
//
//   allow_all    no signal, no extra groups (the default; output unchanged)
//   no_training  search=yes, ai-input=yes, ai-train=no + training-only agents
//   block_all    search=yes, ai-input=no,  ai-train=no + every AI agent below
//
// Multi-purpose search crawlers (Googlebot, Bingbot, Applebot) are never
// listed: blocking them removes the site from search, which no AI policy here
// intends. Google-Extended and Applebot-Extended are the separate tokens
// those companies honour for AI use.

export const AI_CRAWLER_POLICIES = ['allow_all', 'no_training', 'block_all'] as const;
export type AiCrawlerPolicy = (typeof AI_CRAWLER_POLICIES)[number];

export function isAiCrawlerPolicy(value: unknown): value is AiCrawlerPolicy {
  return typeof value === 'string' && (AI_CRAWLER_POLICIES as readonly string[]).includes(value);
}

/** Robots.txt product tokens of crawlers that only collect training data. */
export const AI_TRAINING_USER_AGENTS: readonly string[] = Object.freeze([
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'meta-externalagent',
  'cohere-training-data-crawler',
  'AI2Bot',
]);

/**
 * AI search, answer and user-triggered agents. Blocked only by `block_all`;
 * they cite or fetch pages for a person rather than train on them.
 */
export const AI_ANSWER_USER_AGENTS: readonly string[] = Object.freeze([
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'DuckAssistBot',
  'MistralAI-User',
  'meta-externalfetcher',
]);

/** Search crawlers no AI policy may list (they also power ordinary search results). */
export const SEARCH_CRAWLERS_NEVER_BLOCKED: readonly string[] = Object.freeze(['Googlebot', 'Bingbot', 'Applebot']);

/** The Content Signals value for a policy, or null when nothing is written. */
export function aiContentSignal(policy: unknown): string | null {
  if (policy === 'no_training') return 'search=yes, ai-input=yes, ai-train=no';
  if (policy === 'block_all') return 'search=yes, ai-input=no, ai-train=no';
  return null;
}

/** The user agents a policy disallows. */
export function aiBlockedUserAgents(policy: unknown): string[] {
  if (policy === 'no_training') return [...AI_TRAINING_USER_AGENTS];
  if (policy === 'block_all') return [...AI_TRAINING_USER_AGENTS, ...AI_ANSWER_USER_AGENTS];
  return [];
}

interface RobotsGroup { agents: string[]; hasRules: boolean; agentLines: number[]; lastLine: number }

function robotsGroups(lines: string[]): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup | undefined;
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) return;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'user-agent') {
      if (!group || group.hasRules) { group = { agents: [], hasRules: false, agentLines: [], lastLine: index }; groups.push(group); }
      group.agents.push(value.toLowerCase());
      group.agentLines.push(index);
      group.lastLine = index;
    } else if (group && (name === 'allow' || name === 'disallow')) {
      group.hasRules = true;
      group.lastLine = index;
    } else if (group && name === 'content-signal') {
      group.lastLine = index;
    }
  });
  return groups;
}

/**
 * Apply an AI crawler policy to a complete robots.txt body. `allow_all`
 * returns the input unchanged. Otherwise the Content-Signal line joins the
 * `User-agent: *` group (one is added when missing) and a `Disallow: /` group
 * is appended for each blocked agent the site's own text does not already
 * name: the site's explicit rule for an agent always wins.
 */
export function withAiCrawlerPolicy(robots: string, policy: unknown): string {
  const signal = aiContentSignal(policy);
  if (!signal) return robots;
  const lines = robots.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const groups = robotsGroups(lines);
  const wildcard = groups.find(group => group.agents.includes('*'));
  const hasSignal = wildcard && lines.slice(wildcard.agentLines[0], wildcard.lastLine + 1).some(line => /^\s*content-signal\s*:/i.test(line));
  if (wildcard && !hasSignal) {
    const at = wildcard.agentLines[wildcard.agentLines.length - 1]! + 1;
    lines.splice(at, 0, `Content-Signal: ${signal}`, ...(wildcard.hasRules ? [] : ['Allow: /']));
  } else if (!wildcard) {
    lines.unshift('User-agent: *', `Content-Signal: ${signal}`, 'Allow: /', '');
  }
  const named = new Set(groups.flatMap(group => group.agents));
  const blocked = aiBlockedUserAgents(policy).filter(agent => !named.has(agent.toLowerCase()));
  if (blocked.length) {
    // A trailing group without rules would absorb the next User-agent line.
    const last = robotsGroups(lines).at(-1);
    if (last && !last.hasRules) lines.splice(last.lastLine + 1, 0, 'Allow: /');
    // Keep Sitemap lines at the end, where people expect them.
    const sitemapStart = lines.findIndex((line, index) => /^\s*sitemap\s*:/i.test(line) && lines.slice(index).every(rest => !rest.trim() || /^\s*sitemap\s*:/i.test(rest)));
    const tail = sitemapStart >= 0 ? lines.splice(sitemapStart) : [];
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    for (const agent of blocked) lines.push('', `User-agent: ${agent}`, 'Disallow: /');
    if (tail.length) lines.push('', ...tail.filter(line => line.trim()));
  }
  return `${lines.join('\n')}\n`;
}
