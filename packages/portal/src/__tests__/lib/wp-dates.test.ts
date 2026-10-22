import { expect, it } from 'vitest';
import { wordpressDate } from '../../lib/wp/dates';

it('uses WordPress GMT fields instead of a timezone-less local clock', () => {
  expect(wordpressDate('2024-05-02T11:01:08', '2024-05-02T10:01:08')).toBe('2024-05-02T10:01:08Z');
  expect(wordpressDate('2024-05-02T11:01:08', '2024-05-02T10:01:08+00:00')).toBe('2024-05-02T10:01:08+00:00');
});

it('preserves helper UTC and falls back to known date precision for absent or invalid GMT', () => {
  expect(wordpressDate('2024-05-02T10:01:08Z')).toBe('2024-05-02T10:01:08Z');
  expect(wordpressDate('2024-05-02T11:01:08', null)).toBe('2024-05-02');
  expect(wordpressDate('2024-05-02T11:01:08', '0000-00-00T00:00:00')).toBe('2024-05-02');
  expect(wordpressDate('invalid')).toBe('');
});
