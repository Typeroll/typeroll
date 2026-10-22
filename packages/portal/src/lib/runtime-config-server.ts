import type { PublicRuntimeConfig } from './runtime-config';

export function publicRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PublicRuntimeConfig {
  return {
    firebase: {
      apiKey: env.PUBLIC_FIREBASE_API_KEY || undefined,
      authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN || undefined,
      projectId: env.PUBLIC_FIREBASE_PROJECT_ID || undefined,
      appId: env.PUBLIC_FIREBASE_APP_ID || undefined,
    },
  };
}

/** Serialize JSON safely for an inline application/json script element. */
export function serializePublicRuntimeConfig(config: PublicRuntimeConfig): string {
  return JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * "Continue with GitHub" appears only when the operator enabled Firebase's
 * GitHub provider with a GitHub OAuth App and set
 * PUBLIC_FIREBASE_GITHUB_SIGNIN=true. Self-hosters without one get no button.
 */
export function githubSignInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUBLIC_FIREBASE_GITHUB_SIGNIN?.trim().toLowerCase() === 'true';
}

export function firebaseApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PUBLIC_FIREBASE_API_KEY || undefined;
}
