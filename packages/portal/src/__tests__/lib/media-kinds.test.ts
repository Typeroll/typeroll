import { describe, expect, it } from 'vitest';
import { filterMedia, mediaKind } from '../../components/MediaThumb';

const item = (filename: string, mime_type?: string, alt_text?: string) => ({ id: filename, filename, mime_type, alt_text, cdn_url: `/m/${filename}`, created_at: '' }) as never;

describe('media kinds', () => {
  it('tells images, videos, PDFs, audio and other files apart, by type or by name', () => {
    expect(mediaKind(item('a.jpg', 'image/jpeg'))).toBe('image');
    expect(mediaKind(item('clip.MOV'))).toBe('video');
    expect(mediaKind(item('loop', 'video/webm'))).toBe('video');
    expect(mediaKind(item('prices.pdf', 'application/octet-stream'))).toBe('pdf');
    expect(mediaKind(item('episode.mp3', 'audio/mpeg'))).toBe('audio');
    expect(mediaKind(item('data.csv', 'text/csv'))).toBe('other');
  });
  it('filters by kind, by what a field takes, and by name or description', () => {
    const items = [item('hall.jpg', 'image/jpeg', 'The hall'), item('tour.mp4', 'video/mp4'), item('menu.pdf', 'application/pdf')];
    expect(filterMedia(items, 'video').map((m: { filename: string }) => m.filename)).toEqual(['tour.mp4']);
    expect(filterMedia(items, 'all', '', ['image']).map((m: { filename: string }) => m.filename)).toEqual(['hall.jpg']);
    expect(filterMedia(items, 'all', 'HALL').map((m: { filename: string }) => m.filename)).toEqual(['hall.jpg']);
    expect(filterMedia(items, 'all', 'menu').map((m: { filename: string }) => m.filename)).toEqual(['menu.pdf']);
  });
});
