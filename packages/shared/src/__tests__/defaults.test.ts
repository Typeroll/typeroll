import { describe, it, expect } from 'vitest';
import { ogLocale, slugify } from '../defaults.js';

describe('ogLocale', () => {
  it('defaults to en_US when language is unset', () => {
    expect(ogLocale(undefined)).toBe('en_US');
    expect(ogLocale('')).toBe('en_US');
  });

  it('parses BCP47 with explicit region', () => {
    expect(ogLocale('en-GB')).toBe('en_GB');
    expect(ogLocale('sv-SE')).toBe('sv_SE');
    expect(ogLocale('pt-BR')).toBe('pt_BR');
    expect(ogLocale('de-AT')).toBe('de_AT');
    expect(ogLocale('zh-Hant-TW')).toBe('zh_TW');
  });

  it('infers region from language code as a fallback', () => {
    expect(ogLocale('sv')).toBe('sv_SE');
    expect(ogLocale('fr')).toBe('fr_FR');
    expect(ogLocale('da')).toBe('da_DK');
    expect(ogLocale('invalid tag')).toBe('en_US');
  });

  it('special-cases en → en_US', () => {
    expect(ogLocale('en')).toBe('en_US');
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanum with hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('Foo  Bar')).toBe('foo-bar');
  });
  it('strips leading/trailing hyphens', () => {
    expect(slugify('  Trim Me  ')).toBe('trim-me');
  });
  it('removes diacritics', () => {
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
  });
  it('caps length at 80', () => {
    const long = 'a'.repeat(120);
    expect(slugify(long).length).toBe(80);
  });
});
