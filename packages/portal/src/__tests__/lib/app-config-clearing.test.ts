// A config surface whose whole purpose is holding values that reach visitors
// must let you take one back. Previously an empty value always fell back to
// the stored one, so a non-secret field could not be cleared at all, and a
// caller who believed they had removed a key still shipped it.

import { describe, it, expect } from 'vitest';
import { buildAppState } from '../../lib/apps/config';

const KEY = 'google_places__browser_key';
const existing = { enabled: true, config: { [KEY]: 'AIza' + 'b'.repeat(35) } };

// Narrowed to the record: a string return is a validation failure, and every
// case here expects a built state.
const config = (state: ReturnType<typeof buildAppState>): Record<string, unknown> => {
  if (typeof state === 'string') throw new Error(`Unexpected validation failure: ${state}`);
  return state.config;
};

describe('buildAppState config clearing', () => {
  it('clears a field sent explicitly empty', () => {
    expect(config(buildAppState('integrations', true, { [KEY]: '' }, existing))).not.toHaveProperty(KEY);
  });

  it('preserves a field that was simply omitted', () => {
    // Disabling and partial saves send no config, and must not discard it.
    expect(config(buildAppState('integrations', true, {}, existing))).toHaveProperty(KEY);
  });

  it('preserves config when the app is disabled, so re-enabling stays one click', () => {
    expect(config(buildAppState('integrations', false, {}, existing))).toHaveProperty(KEY);
  });

  it('still clears explicitly even while disabling', () => {
    expect(config(buildAppState('integrations', false, { [KEY]: '' }, existing))).not.toHaveProperty(KEY);
  });

  it('a new value overwrites, as before', () => {
    const replacement = 'AIza' + 'c'.repeat(35);
    expect(config(buildAppState('integrations', true, { [KEY]: replacement }, existing))?.[KEY]).toBe(replacement);
  });

  it('leaves other fields alone when one is cleared', () => {
    const many = { enabled: true, config: { [KEY]: 'AIza' + 'd'.repeat(35), google_analytics__measurement_id: 'G-ABC1234567' } };
    const result = config(buildAppState('integrations', true, { [KEY]: '' }, many));
    expect(result).not.toHaveProperty(KEY);
    expect(result).toHaveProperty('google_analytics__measurement_id', 'G-ABC1234567');
  });
});
