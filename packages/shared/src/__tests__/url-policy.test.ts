import { describe, expect, it } from 'vitest';
import { applyTrailingSlash, normalizeIframeAllowedHosts } from '../index.js';

describe('URL and iframe policies', () => {
  it('applies trailing slash policy without moving query strings or fragments', () => {
    expect(applyTrailingSlash('/about?x=1', 'always')).toBe('/about/?x=1');
    expect(applyTrailingSlash('/about/#team', 'never')).toBe('/about#team');
    expect(applyTrailingSlash('/', 'never')).toBe('/');
  });

  it('normalizes exact iframe hosts and rejects wildcard/URL-shaped entries', () => {
    expect(normalizeIframeAllowedHosts(['Player.Example.com.', 'player.example.com']).hosts)
      .toEqual(['player.example.com']);
    expect(normalizeIframeAllowedHosts(['*.example.com', 'https://example.com', 'localhost', '127.0.0.1']).invalid)
      .toEqual(['*.example.com', 'https://example.com', 'localhost', '127.0.0.1']);
  });
});
