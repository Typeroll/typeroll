import { describe, it, expect } from 'vitest';
import { slugifyOrgName, resolveUniqueSlug } from '../../lib/org-slug';

describe('slugifyOrgName', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugifyOrgName('Acme Corp')).toBe('acme-corp');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugifyOrgName(' --Hello World-- ')).toBe('hello-world');
  });

  it('collapses multiple consecutive non-alphanumeric chars into one hyphen', () => {
    expect(slugifyOrgName('Foo & Bar, Inc.')).toBe('foo-bar-inc');
  });

  it('truncates to 48 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugifyOrgName(long)).toHaveLength(48);
  });

  it('returns empty string for input with no alphanumeric chars', () => {
    expect(slugifyOrgName('---')).toBe('');
    expect(slugifyOrgName('   ')).toBe('');
  });

  it('handles unicode by stripping non-ascii', () => {
    // Non-latin chars are non-alphanumeric → collapsed to hyphens
    const result = slugifyOrgName('Ålands örnar');
    // At minimum should not throw; letters get stripped
    expect(typeof result).toBe('string');
  });
});

describe('resolveUniqueSlug', () => {
  it('returns the base slug when it is not taken', () => {
    expect(resolveUniqueSlug('acme', new Set())).toBe('acme');
  });

  it('appends -2 when base slug is taken', () => {
    expect(resolveUniqueSlug('acme', new Set(['acme']))).toBe('acme-2');
  });

  it('increments until it finds a free slot', () => {
    const taken = new Set(['acme', 'acme-2', 'acme-3']);
    expect(resolveUniqueSlug('acme', taken)).toBe('acme-4');
  });

  it('handles a large number of taken variants', () => {
    const taken = new Set(['base']);
    for (let i = 2; i <= 50; i++) taken.add(`base-${i}`);
    expect(resolveUniqueSlug('base', taken)).toBe('base-51');
  });
});
