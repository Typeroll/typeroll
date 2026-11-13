import { describe, expect, it } from 'vitest';
import { parsePartialTtlDays } from '../../lib/forms/partial-ttl';

describe('partial_ttl_days input', () => {
  it('accepts whole days from 1 to 3650 and absence', () => {
    expect(parsePartialTtlDays(undefined)).toBeUndefined();
    expect(parsePartialTtlDays(1)).toBe(1);
    expect(parsePartialTtlDays(3650)).toBe(3650);
  });
  it('refuses non-numbers, fractions, zero, negatives and huge values', () => {
    for (const value of ['30', 0, -1, 1.5, 3651, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(typeof parsePartialTtlDays(value)).toBe('string');
    }
  });
});
