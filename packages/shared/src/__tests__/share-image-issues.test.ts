import { describe, expect, it } from 'vitest';
import { isSocialImageType, shareImageIssues, shareImageType } from '../social-metadata.js';

describe('share image checks', () => {
  it('reads the type from the media record before the extension', () => {
    expect(shareImageType('https://cdn.test/logo.svg')).toBe('image/svg+xml');
    expect(shareImageType('https://cdn.test/photo.JPG?w=2')).toBe('image/jpeg');
    expect(shareImageType('https://cdn.test/file', 'image/png; charset=binary')).toBe('image/png');
    expect(shareImageType('https://cdn.test/file')).toBe('');
    expect(isSocialImageType('image/webp')).toBe(true);
    expect(isSocialImageType('image/svg+xml')).toBe(false);
  });
  it('reports a missing, unsupported, unknown-size or small image and accepts a large raster', () => {
    expect(shareImageIssues('').map(issue => issue.code)).toEqual(['missing']);
    expect(shareImageIssues('/media/logo.svg').map(issue => issue.code)).toEqual(['unsupported_format']);
    expect(shareImageIssues('/media/card.avif', { width: 1200, height: 630 }).map(issue => issue.code)).toEqual(['unsupported_format']);
    expect(shareImageIssues('/media/card.png').map(issue => issue.code)).toEqual(['unknown_size']);
    expect(shareImageIssues('/media/card.png', { width: 400, height: 210 }).map(issue => issue.code)).toEqual(['too_small']);
    expect(shareImageIssues('/media/card.jpg', { mime_type: 'image/jpeg', width: 1200, height: 630 })).toEqual([]);
  });
});
