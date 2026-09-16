/** First-party event intake policy. Independent of any app producing events. */
export interface AnalyticsEventRule {
  id: string;
  name: string;
  destination: string;
  page_paths?: string[];
  parameters: Array<{ name: string; max_length?: number }>;
}
export function analyticsEventRules(value: unknown): AnalyticsEventRule[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
        typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.name) ||
        typeof item.destination !== 'string' || item.destination.length > 255 || /[\r\n]/.test(item.destination) ||
        !Array.isArray(item.parameters) || item.parameters.length > 32) return null;
    if (item.page_paths !== undefined && (!Array.isArray(item.page_paths) || item.page_paths.some((v: unknown) => typeof v !== 'string' || !v.startsWith('/')))) return null;
    if (item.parameters.some((p: { name?: unknown; max_length?: unknown }) => typeof p?.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(p.name) ||
        /email|phone|address|password|token|name/i.test(p.name) || (p.max_length !== undefined && (!Number.isInteger(p.max_length) || Number(p.max_length) < 1 || Number(p.max_length) > 1024)))) return null;
  }
  return value as AnalyticsEventRule[];
}
