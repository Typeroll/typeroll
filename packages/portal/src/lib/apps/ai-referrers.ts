// AI-assistant referral classification for the Insights dashboard. Maps a
// referer host to a known AI assistant, so "how much traffic comes from
// ChatGPT / Claude / Perplexity" is a first-class number — the AEO
// counterpart of ordinary referrer analytics.

export interface AiAssistant {
  key: string;
  label: string;
  /** Host suffixes that identify this assistant as a referer. */
  hosts: string[];
}

export const AI_ASSISTANTS: AiAssistant[] = [
  { key: 'chatgpt', label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  { key: 'claude', label: 'Claude', hosts: ['claude.ai', 'anthropic.com'] },
  { key: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai'] },
  { key: 'gemini', label: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'] },
  { key: 'copilot', label: 'Copilot', hosts: ['copilot.microsoft.com', 'bing.com'] },
  { key: 'grok', label: 'Grok', hosts: ['grok.com', 'x.ai'] },
];

/** The assistant a referer host belongs to, or null. Host match is suffix-based
 *  (so `www.chatgpt.com` and `chatgpt.com` both classify). */
export function classifyAiReferer(host: string): AiAssistant | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  for (const a of AI_ASSISTANTS) {
    if (a.hosts.some((known) => h === known || h.endsWith(`.${known}`))) return a;
  }
  return null;
}

export interface RefererRow { referer: string; visits: number; pageviews: number }
export interface AiReferralBreakdown {
  by_assistant: Array<{ key: string; label: string; visits: number; pageviews: number }>;
  total_ai_visits: number;
  total_ai_pageviews: number;
}

/** Aggregate raw referer rows into a per-assistant AI-referral breakdown. */
export function aggregateAiReferrals(rows: RefererRow[]): AiReferralBreakdown {
  const acc = new Map<string, { label: string; visits: number; pageviews: number }>();
  for (const row of rows) {
    const a = classifyAiReferer(row.referer);
    if (!a) continue;
    const cur = acc.get(a.key) ?? { label: a.label, visits: 0, pageviews: 0 };
    cur.visits += row.visits;
    cur.pageviews += row.pageviews;
    acc.set(a.key, cur);
  }
  const by_assistant = [...acc.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.visits - a.visits);
  return {
    by_assistant,
    total_ai_visits: by_assistant.reduce((n, a) => n + a.visits, 0),
    total_ai_pageviews: by_assistant.reduce((n, a) => n + a.pageviews, 0),
  };
}
