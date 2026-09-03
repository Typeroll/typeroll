import { describe, expect, it } from 'vitest';
import { aggregateGscMetrics, parseGscCsv } from '../../lib/wp/gsc-import';

describe('GSC import', () => {
  it('parses exports, strips fragments, and sums duplicate URL metrics', () => {
    const rows = parseGscCsv(
      'Page,Clicks,Impressions\n"https://example.com/guide#one",2,10\n"https://example.com/guide#two",3,20\n',
    );
    expect(aggregateGscMetrics(rows)).toEqual([
      { url: 'https://example.com/guide', clicks: 5, impressions: 30 },
    ]);
  });
});
