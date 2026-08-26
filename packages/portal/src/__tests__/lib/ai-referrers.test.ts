// AI-assistant referral classification + aggregation for the Insights
// dashboard.

import { describe, it, expect } from 'vitest';
import { classifyAiReferer, aggregateAiReferrals } from '../../lib/apps/ai-referrers';

describe('classifyAiReferer', () => {
  it('classifies known assistant hosts (incl. www + subdomains)', () => {
    expect(classifyAiReferer('chatgpt.com')?.key).toBe('chatgpt');
    expect(classifyAiReferer('www.chatgpt.com')?.key).toBe('chatgpt');
    expect(classifyAiReferer('chat.openai.com')?.key).toBe('chatgpt');
    expect(classifyAiReferer('claude.ai')?.key).toBe('claude');
    expect(classifyAiReferer('www.perplexity.ai')?.key).toBe('perplexity');
    expect(classifyAiReferer('gemini.google.com')?.key).toBe('gemini');
    expect(classifyAiReferer('copilot.microsoft.com')?.key).toBe('copilot');
  });

  it('returns null for ordinary + lookalike hosts', () => {
    expect(classifyAiReferer('google.com')).toBeNull();
    expect(classifyAiReferer('example.com')).toBeNull();
    // suffix match must be on a dot boundary — not a substring
    expect(classifyAiReferer('notchatgpt.com')).toBeNull();
    expect(classifyAiReferer('claude.ai.evil.com')).toBeNull();
  });
});

describe('aggregateAiReferrals', () => {
  it('folds referer rows into a per-assistant breakdown, AI-only, sorted', () => {
    const rows = [
      { referer: 'chatgpt.com', visits: 10, pageviews: 14 },
      { referer: 'www.chatgpt.com', visits: 5, pageviews: 6 },
      { referer: 'claude.ai', visits: 8, pageviews: 9 },
      { referer: 'google.com', visits: 100, pageviews: 120 }, // not AI → excluded
      { referer: '(direct)', visits: 50, pageviews: 60 },
    ];
    const out = aggregateAiReferrals(rows);
    expect(out.by_assistant.map((a) => a.key)).toEqual(['chatgpt', 'claude']); // chatgpt 15 > claude 8
    expect(out.by_assistant[0]).toMatchObject({ key: 'chatgpt', visits: 15, pageviews: 20 });
    expect(out.total_ai_visits).toBe(23);
    expect(out.total_ai_pageviews).toBe(29);
  });

  it('empty input → zeroed breakdown', () => {
    const out = aggregateAiReferrals([]);
    expect(out.by_assistant).toEqual([]);
    expect(out.total_ai_visits).toBe(0);
  });
});
