import { describe, it, expect } from 'vitest';
import {
  canonicalTag,
  isValidAlternateHref,
  isValidHreflangTag,
  resolveAlternates,
  validateAlternates,
} from '../hreflang.js';

describe('isValidHreflangTag', () => {
  it('accepts language, language-region, and language-script-region', () => {
    expect(isValidHreflangTag('sv')).toBe(true);
    expect(isValidHreflangTag('en-GB')).toBe(true);
    expect(isValidHreflangTag('zh-Hant-TW')).toBe(true);
    expect(isValidHreflangTag('es-419')).toBe(true);
  });

  it('accepts x-default in any casing', () => {
    expect(isValidHreflangTag('x-default')).toBe(true);
    expect(isValidHreflangTag('X-Default')).toBe(true);
  });

  it('accepts the lowercase region form humans and agents actually write', () => {
    expect(isValidHreflangTag('en-gb')).toBe(true);
  });

  it('rejects anything that could break out of the attribute', () => {
    expect(isValidHreflangTag('en" onload="alert(1)')).toBe(false);
    expect(isValidHreflangTag('sv><script>')).toBe(false);
    expect(isValidHreflangTag('')).toBe(false);
    expect(isValidHreflangTag('english')).toBe(false);
    expect(isValidHreflangTag('sv_SE')).toBe(false);
  });
});

describe('canonicalTag', () => {
  it('normalizes casing per BCP-47', () => {
    expect(canonicalTag('EN-gb')).toBe('en-GB');
    expect(canonicalTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalTag('SV')).toBe('sv');
  });
});

describe('isValidAlternateHref', () => {
  it('requires an absolute http(s) URL', () => {
    expect(isValidAlternateHref('https://example.de/ueber-uns')).toBe(true);
    expect(isValidAlternateHref('http://example.de/')).toBe(true);
    expect(isValidAlternateHref('/om-oss')).toBe(false);
    expect(isValidAlternateHref('//example.de/x')).toBe(false);
    expect(isValidAlternateHref('javascript:alert(1)')).toBe(false);
    expect(isValidAlternateHref('data:text/html,<script>')).toBe(false);
  });
});

describe('validateAlternates', () => {
  it('canonicalizes tags and reports every rejection with a reason', () => {
    const { valid, rejected } = validateAlternates([
      { hreflang: 'en-gb', href: 'https://example.co.uk/about' },
      { hreflang: 'bogus tag', href: 'https://example.de/x' },
      { hreflang: 'de', href: '/relative' },
    ]);
    expect(valid).toEqual([{ hreflang: 'en-GB', href: 'https://example.co.uk/about' }]);
    expect(rejected).toHaveLength(2);
    expect(rejected.join(' ')).toContain('bogus tag');
    expect(rejected.join(' ')).toContain('invalid href for de');
  });

  it('drops duplicate tags rather than emitting a conflicting cluster', () => {
    const { valid, rejected } = validateAlternates([
      { hreflang: 'de', href: 'https://example.de/a' },
      { hreflang: 'DE', href: 'https://example.de/b' },
    ]);
    expect(valid).toHaveLength(1);
    expect(rejected[0]).toContain('duplicate');
  });

  it('treats a non-array as empty rather than throwing', () => {
    expect(validateAlternates(undefined).valid).toEqual([]);
    expect(validateAlternates('nope').rejected).toHaveLength(1);
  });
});

describe('resolveAlternates', () => {
  it('injects the self-reference first — Google drops clusters that omit it', () => {
    const out = resolveAlternates(
      [{ hreflang: 'de', href: 'https://example.de/ueber-uns' }],
      'https://example.se/om-oss',
      'sv',
    );
    expect(out).toEqual([
      { hreflang: 'sv', href: 'https://example.se/om-oss' },
      { hreflang: 'de', href: 'https://example.de/ueber-uns' },
    ]);
  });

  it('lets an explicitly declared self-tag win over the injected one', () => {
    const out = resolveAlternates(
      [
        { hreflang: 'sv', href: 'https://example.se/canonical-om-oss' },
        { hreflang: 'de', href: 'https://example.de/ueber-uns' },
      ],
      'https://example.se/om-oss',
      'sv',
    );
    expect(out[0]).toEqual({ hreflang: 'sv', href: 'https://example.se/canonical-om-oss' });
    expect(out).toHaveLength(2);
  });

  it('emits nothing when no alternates are declared — a lone self-link is noise', () => {
    expect(resolveAlternates([], 'https://example.se/om-oss', 'sv')).toEqual([]);
    expect(resolveAlternates(undefined, 'https://example.se/om-oss', 'sv')).toEqual([]);
  });

  it('still emits the declared cluster when the page language is unusable', () => {
    const out = resolveAlternates(
      [{ hreflang: 'de', href: 'https://example.de/x' }],
      'https://example.se/om-oss',
      'not a language',
    );
    expect(out).toEqual([{ hreflang: 'de', href: 'https://example.de/x' }]);
  });
});
