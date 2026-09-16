// The apps config engine (schema-driven, mirrors email connector-config).
// Pins: enable/disable state, config validation, the PUBLIC build-snapshot
// projection (only enabled apps' declared public_keys reach the customer
// site — never secrets or server-only config), and masking.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildAppState,
  maskAppState,
  publicAppsSnapshot,
  resolveAppConfig,
  isAppEnabled,
} from '../../lib/apps/config';
import type { SiteApps } from '@typeroll/shared';

beforeEach(() => {
  process.env.INTEGRATIONS_SECRET_KEY = 'test-key-'.repeat(6); // ≥32 chars
});

describe('buildAppState (analytics)', () => {
  it('stores enabled + public config and stamps enabled_at', () => {
    const state = buildAppState('analytics', true, { beacon_token: 'abc123', site_tag: 'tagX' }, undefined);
    expect(typeof state).not.toBe('string');
    if (typeof state === 'string') return;
    expect(state.enabled).toBe(true);
    expect(state.config).toMatchObject({ beacon_token: 'abc123', site_tag: 'tagX' });
    expect(state.enabled_at).toBeTruthy();
  });

  it('disabling clears enabled_at but keeps config', () => {
    const enabled = buildAppState('analytics', true, { beacon_token: 'abc123' }, undefined) as Exclude<ReturnType<typeof buildAppState>, string>;
    const disabled = buildAppState('analytics', false, { beacon_token: 'abc123' }, enabled) as Exclude<ReturnType<typeof buildAppState>, string>;
    expect(disabled.enabled).toBe(false);
    expect(disabled.enabled_at).toBeUndefined();
    expect(disabled.config.beacon_token).toBe('abc123');
  });

  it('rejects an unknown app', () => {
    expect(buildAppState('nope', true, {}, undefined)).toContain('Unknown app');
  });

  it('preserves enabled_at across a re-save while enabled', () => {
    const first = buildAppState('analytics', true, { beacon_token: 'a' }, undefined) as Exclude<ReturnType<typeof buildAppState>, string>;
    const again = buildAppState('analytics', true, { beacon_token: 'b' }, first) as Exclude<ReturnType<typeof buildAppState>, string>;
    expect(again.enabled_at).toBe(first.enabled_at);
    expect(again.config.beacon_token).toBe('b');
  });
});

describe('publicAppsSnapshot — the build projection', () => {
  it('blocks an enabled legacy module instead of silently omitting its runtime', () => {
    expect(() => publicAppsSnapshot({ apps: { retired_module: { enabled: true, config: {} } } } as unknown as SiteApps)).toThrow('requires migration');
  });
  it('includes only enabled apps, only their public_keys', () => {
    const doc: SiteApps = {
      apps: {
        analytics: { enabled: true, config: { beacon_token: 'BEACON', site_tag: 'SERVER_ONLY' } },
      },
    };
    const snap = publicAppsSnapshot(doc);
    expect(snap.apps?.analytics?.enabled).toBe(true);
    // beacon_token is public (public_keys); site_tag is server-only → excluded.
    expect(snap.apps?.analytics?.config).toEqual({ beacon_token: 'BEACON' });
    expect(snap.apps?.analytics?.config.site_tag).toBeUndefined();
  });

  it('excludes disabled apps entirely', () => {
    const doc: SiteApps = { apps: { analytics: { enabled: false, config: { beacon_token: 'X' } } } };
    expect(publicAppsSnapshot(doc).apps).toEqual({});
  });

  it('empty/absent doc → no apps', () => {
    expect(publicAppsSnapshot(undefined).apps).toEqual({});
    expect(publicAppsSnapshot({ apps: {} }).apps).toEqual({});
  });
});

describe('maskAppState + resolveAppConfig + isAppEnabled', () => {
  it('mask returns declared fields with non-secret values', () => {
    const masked = maskAppState('analytics', { enabled: true, config: { beacon_token: 'tok' } });
    expect(masked.enabled).toBe(true);
    expect(masked.config.beacon_token).toBe('tok');
  });

  it('resolve returns config values (analytics has no secrets)', () => {
    const values = resolveAppConfig('analytics', { enabled: true, config: { beacon_token: 'tok', site_tag: 'st' } });
    expect(values).toMatchObject({ beacon_token: 'tok', site_tag: 'st' });
  });

  it('isAppEnabled reads the doc', () => {
    expect(isAppEnabled({ apps: { analytics: { enabled: true, config: {} } } }, 'analytics')).toBe(true);
    expect(isAppEnabled({ apps: { analytics: { enabled: false, config: {} } } }, 'analytics')).toBe(false);
    expect(isAppEnabled(undefined, 'analytics')).toBe(false);
  });
});
