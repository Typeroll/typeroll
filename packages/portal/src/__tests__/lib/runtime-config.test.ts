import { describe, expect, it } from 'vitest';
import {
  parsePublicRuntimeConfig,
  RUNTIME_CONFIG_ELEMENT_ID,
} from '../../lib/runtime-config';
import {
  firebaseApiKey,
  publicRuntimeConfigFromEnv,
  serializePublicRuntimeConfig,
} from '../../lib/runtime-config-server';

describe('public runtime config', () => {
  it('maps Firebase web settings from the process environment', () => {
    const env = {
      PUBLIC_FIREBASE_API_KEY: 'runtime-key',
      PUBLIC_FIREBASE_AUTH_DOMAIN: 'auth.example.test',
      PUBLIC_FIREBASE_PROJECT_ID: 'runtime-project',
      PUBLIC_FIREBASE_APP_ID: 'runtime-app',
    } as NodeJS.ProcessEnv;

    expect(publicRuntimeConfigFromEnv(env)).toEqual({
      firebase: {
        apiKey: 'runtime-key',
        authDomain: 'auth.example.test',
        projectId: 'runtime-project',
        appId: 'runtime-app',
      },
    });
    expect(firebaseApiKey(env)).toBe('runtime-key');
  });

  it('omits empty values instead of exposing build-time placeholders', () => {
    expect(publicRuntimeConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      firebase: {
        apiKey: undefined,
        authDomain: undefined,
        projectId: undefined,
        appId: undefined,
      },
    });
    expect(firebaseApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('escapes script-closing input and round-trips valid configuration', () => {
    const serialized = serializePublicRuntimeConfig({
      firebase: {
        apiKey: '</script><script>alert(1)</script>',
        projectId: 'project',
      },
    });

    expect(serialized).not.toContain('</script>');
    expect(parsePublicRuntimeConfig(serialized)).toEqual({
      firebase: {
        apiKey: '</script><script>alert(1)</script>',
        authDomain: undefined,
        projectId: 'project',
        appId: undefined,
      },
    });
  });

  it('fails closed for malformed or wrongly-shaped JSON', () => {
    expect(parsePublicRuntimeConfig('{')).toEqual({ firebase: {} });
    expect(parsePublicRuntimeConfig('{"firebase":"wrong"}')).toEqual({ firebase: {} });
    expect(RUNTIME_CONFIG_ELEMENT_ID).toBe('typeroll-runtime-config');
  });
});
