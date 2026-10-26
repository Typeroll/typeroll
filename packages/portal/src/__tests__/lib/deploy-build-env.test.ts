import { expect, it } from 'vitest';
import { buildProcessEnv } from '../../lib/deploy/runner';

it('gives the legacy site build only an allowlisted environment, never portal secrets', () => {
  const env = buildProcessEnv({
    PATH: '/usr/bin', HOME: '/home/app', NODE_OPTIONS: '--max-old-space-size=2048',
    FIREBASE_SERVICE_ACCOUNT: '{"private_key":"secret"}', FORMS_HMAC_SECRET: 'hmac', INTEGRATIONS_SECRET_KEY: 'key',
    CLOUDFLARE_API_TOKEN: 'cf', GITHUB_APP_PRIVATE_KEY: 'gh', ANTHROPIC_API_KEY: 'ai', SESSION_SECRET: 'session',
  }, { TYPEROLL_SITE_ID: 'site', TYPEROLL_FIXTURES_DIR: '/tmp/fixtures' });
  expect(env).toEqual({
    PATH: '/usr/bin', HOME: '/home/app', NODE_OPTIONS: '--max-old-space-size=2048', ASTRO_TELEMETRY_DISABLED: '1',
    TYPEROLL_SITE_ID: 'site', TYPEROLL_FIXTURES_DIR: '/tmp/fixtures',
  });
});
