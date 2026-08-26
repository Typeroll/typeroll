import { describe, it, expect } from 'vitest';
import {
  isRedirectPattern,
  matchRedirect,
  pagesShadowedByRedirect,
  redirectSpecificity,
  sortRedirectsForEmit,
  validateRedirectPattern,
} from '../redirect-patterns.js';

describe('isRedirectPattern', () => {
  it('separates literals from patterns', () => {
    expect(isRedirectPattern('/om-oss')).toBe(false);
    expect(isRedirectPattern('/category/*')).toBe(true);
    expect(isRedirectPattern('/blog/:slug')).toBe(true);
    // A colon inside a segment is not a placeholder.
    expect(isRedirectPattern('/pris:lista')).toBe(false);
  });
});

describe('validateRedirectPattern', () => {
  it('accepts the supported shapes', () => {
    expect(validateRedirectPattern('/category/*', '/blogg/:splat').ok).toBe(true);
    expect(validateRedirectPattern('/blog/:slug', '/artiklar/:slug').ok).toBe(true);
    expect(validateRedirectPattern('/shop/:cat/:id', '/butik/:cat/:id').ok).toBe(true);
    expect(validateRedirectPattern('/gammal', '/ny').ok).toBe(true);
  });

  it('rejects a mid-path splat — Cloudflare would drop the rule silently', () => {
    const res = validateRedirectPattern('/blog/*/kommentarer', '/x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('END');
  });

  it('rejects more than one splat', () => {
    expect(validateRedirectPattern('/a/*/b/*', '/x').ok).toBe(false);
  });

  it('rejects :splat when nothing was captured', () => {
    const res = validateRedirectPattern('/blog/:slug', '/artiklar/:splat');
    expect(res.ok).toBe(false);
    expect(res.error).toContain(':splat');
  });

  it('rejects a target referencing an undeclared placeholder', () => {
    const res = validateRedirectPattern('/blog/:slug', '/artiklar/:year');
    expect(res.ok).toBe(false);
    expect(res.error).toContain(':year');
  });

  it('rejects query strings with an explanation, not a generic error', () => {
    const res = validateRedirectPattern('/?p=123', '/x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('query strings');
  });

  it('rejects whitespace — _redirects is space-delimited', () => {
    expect(validateRedirectPattern('/old page', '/ny').ok).toBe(false);
  });

  it('rejects a splat in the target', () => {
    expect(validateRedirectPattern('/a/*', '/b/*').ok).toBe(false);
  });

  it('requires a leading slash', () => {
    expect(validateRedirectPattern('category/*', '/x').ok).toBe(false);
  });
});

describe('matchRedirect', () => {
  it('replays the captured remainder into :splat', () => {
    expect(matchRedirect('/category/*', '/blogg/:splat', '/category/mat/recept'))
      .toBe('/blogg/mat/recept');
  });

  it('matches the prefix itself, not just paths below it', () => {
    // "/category/*" means "everything under here, including the index" —
    // the WP taxonomy root is exactly the URL people have linked to.
    expect(matchRedirect('/category/*', '/blogg/:splat', '/category')).toBe('/blogg/');
  });

  it('binds one segment per named placeholder', () => {
    expect(matchRedirect('/blog/:slug', '/artiklar/:slug', '/blog/hej')).toBe('/artiklar/hej');
    expect(matchRedirect('/blog/:slug', '/artiklar/:slug', '/blog/hej/da')).toBeNull();
  });

  it('handles several placeholders', () => {
    expect(matchRedirect('/shop/:cat/:id', '/butik/:cat/:id', '/shop/skor/42'))
      .toBe('/butik/skor/42');
  });

  it('does not match a different prefix', () => {
    expect(matchRedirect('/category/*', '/blogg/:splat', '/produkt/x')).toBeNull();
  });

  it('ignores a trailing slash difference', () => {
    expect(matchRedirect('/gammal', '/ny', '/gammal/')).toBe('/ny');
  });

  it('supports an absolute target', () => {
    expect(matchRedirect('/gammal/*', 'https://annan.example.com/:splat', '/gammal/x'))
      .toBe('https://annan.example.com/x');
  });
});

describe('ordering', () => {
  it('ranks literals above patterns and deeper patterns above shallower', () => {
    expect(redirectSpecificity('/blogg/recept')).toBeGreaterThan(redirectSpecificity('/blogg/*'));
    expect(redirectSpecificity('/blogg/recept/*')).toBeGreaterThan(redirectSpecificity('/blogg/*'));
    expect(redirectSpecificity('/blogg/:slug')).toBeGreaterThan(redirectSpecificity('/blogg/*'));
  });

  it('emits the narrow rule before the broad one so it can actually fire', () => {
    const sorted = sortRedirectsForEmit([
      { from_path: '/blogg/*' },
      { from_path: '/blogg/recept/*' },
      { from_path: '/blogg/recept/pannkakor' },
    ]);
    expect(sorted.map((r) => r.from_path)).toEqual([
      '/blogg/recept/pannkakor',
      '/blogg/recept/*',
      '/blogg/*',
    ]);
  });

  it('is stable for equally specific rules', () => {
    const input = [{ from_path: '/a/*' }, { from_path: '/b/*' }, { from_path: '/c/*' }];
    expect(sortRedirectsForEmit(input).map((r) => r.from_path)).toEqual(['/a/*', '/b/*', '/c/*']);
  });
});

describe('pagesShadowedByRedirect', () => {
  const livePages = ['/', '/om-oss', '/blogg', '/blogg/hej', '/blogg/da'];

  it('finds every live page a wildcard would hide', () => {
    expect(pagesShadowedByRedirect('/blogg/*', '/nyheter/:splat', livePages))
      .toEqual(['/blogg', '/blogg/hej', '/blogg/da']);
  });

  it('is quiet when the pattern covers only dead URLs', () => {
    expect(pagesShadowedByRedirect('/category/*', '/blogg/:splat', livePages)).toEqual([]);
  });

  it('catches an exact rule over a live page too', () => {
    expect(pagesShadowedByRedirect('/om-oss', '/about', livePages)).toEqual(['/om-oss']);
  });

  it('does not count a rule that resolves to the same URL as shadowing', () => {
    // /blogg/* → /blogg/:splat is a no-op for the pages it matches; it can
    // only ever redirect them to themselves, so nothing is hidden.
    expect(pagesShadowedByRedirect('/blogg/*', '/blogg/:splat', livePages)).toEqual([]);
  });
});
