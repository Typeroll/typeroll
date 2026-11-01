import { describe, expect, it } from 'vitest';
import {
  AI_ANSWER_USER_AGENTS, AI_TRAINING_USER_AGENTS, SEARCH_CRAWLERS_NEVER_BLOCKED, aiBlockedUserAgents, aiContentSignal,
  isAiCrawlerPolicy, withAiCrawlerPolicy, withSitemapLines,
} from '../index.js';
// The site template's own robots.txt evaluator, the one publication validation uses.
const robotsPolicyUrl = new URL('../../../site-template/src/lib/robots-policy.mjs', import.meta.url).href;
const { robotsAllows } = await import(robotsPolicyUrl) as { robotsAllows: (source: string, pathname: string, product?: string) => boolean };

const DEFAULT = withSitemapLines(undefined, ['https://example.com/sitemap.xml', 'https://example.com/sitemap-images.xml']);

describe('AI crawler policy', () => {
  it('never lists multi-purpose search crawlers', () => {
    const listed = [...AI_TRAINING_USER_AGENTS, ...AI_ANSWER_USER_AGENTS].map(agent => agent.toLowerCase());
    for (const crawler of SEARCH_CRAWLERS_NEVER_BLOCKED) expect(listed).not.toContain(crawler.toLowerCase());
    for (const policy of ['allow_all', 'no_training', 'block_all']) {
      const robots = withAiCrawlerPolicy(DEFAULT, policy);
      for (const crawler of ['Googlebot', 'Bingbot', 'Applebot', 'Google-InspectionTool']) {
        expect(robotsAllows(robots, '/', crawler)).toBe(true);
        expect(robotsAllows(robots, '/some/page/', crawler)).toBe(true);
      }
    }
  });

  it('accepts only the three policies', () => {
    expect(['allow_all', 'no_training', 'block_all'].every(isAiCrawlerPolicy)).toBe(true);
    expect(isAiCrawlerPolicy('allow')).toBe(false);
    expect(isAiCrawlerPolicy(undefined)).toBe(false);
  });

  it('writes nothing for allow_all or an absent setting', () => {
    expect(withAiCrawlerPolicy(DEFAULT, undefined)).toBe(DEFAULT);
    expect(withAiCrawlerPolicy(DEFAULT, 'allow_all')).toBe(DEFAULT);
    expect(aiContentSignal('allow_all')).toBeNull();
    expect(aiBlockedUserAgents(undefined)).toEqual([]);
  });

  it('uses the Content Signals vocabulary Cloudflare uses', () => {
    expect(aiContentSignal('no_training')).toBe('search=yes, ai-input=yes, ai-train=no');
    expect(aiContentSignal('block_all')).toBe('search=yes, ai-input=no, ai-train=no');
  });

  it('adds the signal to the wildcard group and disallows training crawlers only', () => {
    const robots = withAiCrawlerPolicy(DEFAULT, 'no_training');
    expect(robots).toBe([
      'User-agent: *',
      'Content-Signal: search=yes, ai-input=yes, ai-train=no',
      'Allow: /',
      ...AI_TRAINING_USER_AGENTS.flatMap(agent => ['', `User-agent: ${agent}`, 'Disallow: /']),
      '',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://example.com/sitemap-images.xml',
      '',
    ].join('\n'));
    expect(robotsAllows(robots, '/', 'GPTBot')).toBe(false);
    expect(robotsAllows(robots, '/', 'OAI-SearchBot')).toBe(true);
    expect(robotsAllows(robots, '/', 'ClaudeBot')).toBe(false);
    expect(robotsAllows(robots, '/', 'Claude-User')).toBe(true);
  });

  it('blocks AI answer agents too with block_all, but keeps search', () => {
    const robots = withAiCrawlerPolicy(DEFAULT, 'block_all');
    expect(robots).toContain('Content-Signal: search=yes, ai-input=no, ai-train=no');
    for (const agent of [...AI_TRAINING_USER_AGENTS, ...AI_ANSWER_USER_AGENTS]) expect(robotsAllows(robots, '/', agent)).toBe(false);
    expect(robotsAllows(robots, '/', 'Googlebot')).toBe(true);
  });

  it('keeps the site\'s own rules and its explicit choice for an agent', () => {
    const custom = 'User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nAllow: /\n\nSitemap: https://example.com/custom.xml\n';
    const robots = withAiCrawlerPolicy(custom, 'no_training');
    expect(robots.startsWith('User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nDisallow: /private/\n')).toBe(true);
    expect(robots.match(/User-agent: GPTBot/g)).toHaveLength(1);
    expect(robotsAllows(robots, '/', 'GPTBot')).toBe(true);
    expect(robotsAllows(robots, '/', 'CCBot')).toBe(false);
    expect(robotsAllows(robots, '/private/x', 'Googlebot')).toBe(false);
    expect(robots.trimEnd().endsWith('Sitemap: https://example.com/custom.xml')).toBe(true);
  });

  it('adds a wildcard group when the site has none, without capturing other groups', () => {
    const robots = withAiCrawlerPolicy('User-agent: Googlebot\nDisallow: /tmp/\n', 'no_training');
    expect(robots.startsWith('User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n\nUser-agent: Googlebot\n')).toBe(true);
    expect(robotsAllows(robots, '/tmp/a', 'Googlebot')).toBe(false);
    expect(robotsAllows(robots, '/', 'Googlebot')).toBe(true);
  });

  it('closes a trailing group without rules so it cannot absorb the policy groups', () => {
    const robots = withAiCrawlerPolicy('User-agent: *\nAllow: /\n\nUser-agent: Googlebot\n', 'no_training');
    expect(robotsAllows(robots, '/', 'Googlebot')).toBe(true);
    expect(robotsAllows(robots, '/', 'GPTBot')).toBe(false);
  });

  it('does not repeat an existing Content-Signal line', () => {
    const custom = 'User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n';
    expect(withAiCrawlerPolicy(custom, 'no_training').match(/Content-Signal/g)).toHaveLength(1);
  });
});
