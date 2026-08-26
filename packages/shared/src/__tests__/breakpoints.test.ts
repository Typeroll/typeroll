import { describe, it, expect } from 'vitest';
import {
  BREAKPOINTS,
  BREAKPOINT_ORDER,
  BREAKPOINTS_ABOVE_MOBILE,
  isResponsiveValue,
  resolveResponsive,
  expandResponsive,
  mediaQuery,
} from '../breakpoints.js';

describe('Breakpoint constants', () => {
  it('lists exactly the five expected breakpoints in mobile-first order', () => {
    expect(BREAKPOINT_ORDER).toEqual(['mobile', 'tablet', 'laptop', 'desktop', 'wide']);
  });

  it('mobile starts at 0, the others at Tailwind-compatible thresholds', () => {
    expect(BREAKPOINTS.mobile.min).toBe(0);
    expect(BREAKPOINTS.tablet.min).toBe(640);
    expect(BREAKPOINTS.laptop.min).toBe(1024);
    expect(BREAKPOINTS.desktop.min).toBe(1280);
    expect(BREAKPOINTS.wide.min).toBe(1536);
  });

  it('BREAKPOINTS_ABOVE_MOBILE excludes mobile', () => {
    expect(BREAKPOINTS_ABOVE_MOBILE).toEqual(['tablet', 'laptop', 'desktop', 'wide']);
  });
});

describe('isResponsiveValue', () => {
  it('returns true for objects with at least one breakpoint key', () => {
    expect(isResponsiveValue({ mobile: 1 })).toBe(true);
    expect(isResponsiveValue({ desktop: 'lg' })).toBe(true);
  });

  it('returns false for scalars', () => {
    expect(isResponsiveValue(1)).toBe(false);
    expect(isResponsiveValue('hello')).toBe(false);
    expect(isResponsiveValue(true)).toBe(false);
    expect(isResponsiveValue(null)).toBe(false);
    expect(isResponsiveValue(undefined)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isResponsiveValue([1, 2, 3])).toBe(false);
  });

  it('returns false for objects without breakpoint keys', () => {
    expect(isResponsiveValue({ foo: 1, bar: 2 })).toBe(false);
  });
});

describe('resolveResponsive', () => {
  it('returns scalar values as-is at any breakpoint', () => {
    expect(resolveResponsive('md', 'mobile')).toBe('md');
    expect(resolveResponsive('md', 'desktop')).toBe('md');
  });

  it('returns undefined for undefined input', () => {
    expect(resolveResponsive(undefined, 'mobile')).toBeUndefined();
  });

  it('mobile-first inheritance: missing BPs inherit from the previous defined BP', () => {
    const v = { mobile: 'sm', laptop: 'xl' };
    expect(resolveResponsive(v, 'mobile')).toBe('sm');
    expect(resolveResponsive(v, 'tablet')).toBe('sm');   // inherits mobile
    expect(resolveResponsive(v, 'laptop')).toBe('xl');
    expect(resolveResponsive(v, 'desktop')).toBe('xl');  // inherits laptop
    expect(resolveResponsive(v, 'wide')).toBe('xl');     // inherits laptop
  });

  it('falls forward when only larger breakpoints are defined', () => {
    const v = { tablet: 'md', desktop: 'lg' };
    // mobile has nothing below; falls forward to tablet
    expect(resolveResponsive(v, 'mobile')).toBe('md');
  });

  it('handles all five breakpoints set explicitly', () => {
    const v = { mobile: 'a', tablet: 'b', laptop: 'c', desktop: 'd', wide: 'e' };
    expect(resolveResponsive(v, 'mobile')).toBe('a');
    expect(resolveResponsive(v, 'wide')).toBe('e');
  });
});

describe('expandResponsive', () => {
  it('fills all five breakpoints from a sparse value', () => {
    const expanded = expandResponsive({ mobile: 'sm', laptop: 'xl' });
    expect(expanded).toEqual({
      mobile: 'sm',
      tablet: 'sm',
      laptop: 'xl',
      desktop: 'xl',
      wide: 'xl',
    });
  });

  it('returns undefined for every BP when input is undefined', () => {
    const expanded = expandResponsive<string>(undefined);
    for (const bp of BREAKPOINT_ORDER) {
      expect(expanded[bp]).toBeUndefined();
    }
  });
});

describe('mediaQuery', () => {
  it('returns empty string for mobile (no query needed)', () => {
    expect(mediaQuery('mobile')).toBe('');
  });

  it('returns a min-width query for non-mobile BPs', () => {
    expect(mediaQuery('tablet')).toBe('@media (min-width: 640px)');
    expect(mediaQuery('laptop')).toBe('@media (min-width: 1024px)');
    expect(mediaQuery('desktop')).toBe('@media (min-width: 1280px)');
    expect(mediaQuery('wide')).toBe('@media (min-width: 1536px)');
  });
});
