import { GoogleAuth } from 'google-auth-library';

export interface GscUrlMetric {
  url: string;
  clicks: number;
  impressions: number;
}

interface GscApiRow {
  keys?: unknown[];
  clicks?: unknown;
  impressions?: unknown;
}

/** Parse the page-level CSV exported by Google Search Console. Column names
 * are accepted in English or Swedish and matching is case-insensitive. */
export function parseGscCsv(csv: string): GscUrlMetric[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.trim().toLocaleLowerCase('sv-SE'));
  const pageIndex = findHeader(headers, ['page', 'pages', 'url', 'sida', 'sidor']);
  const clickIndex = findHeader(headers, ['clicks', 'click', 'klick']);
  const impressionIndex = findHeader(headers, ['impressions', 'impression', 'visningar']);
  if (pageIndex < 0) throw new Error('GSC CSV must contain a Page/URL column');
  return rows.slice(1).flatMap((row) => {
    const url = row[pageIndex]?.trim();
    if (!url) return [];
    return [{
      url,
      clicks: parseMetric(row[clickIndex]),
      impressions: parseMetric(row[impressionIndex]),
    }];
  });
}

/** Strip fragments and aggregate duplicates before writing the inventory. */
export function aggregateGscMetrics(rows: GscUrlMetric[]): GscUrlMetric[] {
  const aggregated = new Map<string, GscUrlMetric>();
  for (const row of rows) {
    const raw = row.url.trim();
    if (!raw) continue;
    let url = raw;
    try {
      const parsed = raw.startsWith('/') ? new URL(raw, 'https://placeholder.invalid') : new URL(raw);
      parsed.hash = '';
      url = raw.startsWith('/') ? `${parsed.pathname}${parsed.search}` : parsed.toString();
    } catch {
      url = raw.split('#', 1)[0];
    }
    const existing = aggregated.get(url) ?? { url, clicks: 0, impressions: 0 };
    existing.clicks += finiteMetric(row.clicks);
    existing.impressions += finiteMetric(row.impressions);
    aggregated.set(url, existing);
  }
  return [...aggregated.values()];
}

export async function fetchGscMetrics(args: {
  property: string;
  months?: number;
  auth?: GoogleAuth;
}): Promise<GscUrlMetric[]> {
  const months = Math.min(16, Math.max(1, Math.floor(args.months ?? 3)));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - months);

  const auth = args.auth ?? createGoogleAuth();
  const client = await auth.getClient();
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(args.property)}/searchAnalytics/query`;
  const rows: GscUrlMetric[] = [];
  const rowLimit = 25_000;
  for (let startRow = 0; ; startRow += rowLimit) {
    const response = await client.request<{ rows?: GscApiRow[] }>({
      url: endpoint,
      method: 'POST',
      data: {
        startDate: isoDate(start),
        endDate: isoDate(end),
        dimensions: ['page'],
        rowLimit,
        startRow,
      },
    });
    const batch = response.data.rows ?? [];
    for (const row of batch) {
      const url = typeof row.keys?.[0] === 'string' ? row.keys[0] : '';
      if (!url) continue;
      rows.push({
        url,
        clicks: finiteMetric(row.clicks),
        impressions: finiteMetric(row.impressions),
      });
    }
    if (batch.length < rowLimit) break;
  }
  return aggregateGscMetrics(rows);
}

function createGoogleAuth(): GoogleAuth {
  const raw = process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS?.trim();
  if (raw) {
    let credentials: Record<string, unknown>;
    try { credentials = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('GOOGLE_SEARCH_CONSOLE_CREDENTIALS is not valid JSON'); }
    return new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
  }
  return new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
}

function parseCsv(input: string): string[][] {
  const firstLine = input.split(/\r?\n/u, 1)[0] ?? '';
  const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field); field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(field); field = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function findHeader(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => candidates.includes(header.replace(/^\uFEFF/u, '')));
}

function parseMetric(value: string | undefined): number {
  if (!value) return 0;
  return finiteMetric(Number(value.replace(/\s/g, '').replace(',', '.')));
}

function finiteMetric(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
