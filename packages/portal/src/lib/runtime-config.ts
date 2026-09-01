export const RUNTIME_CONFIG_ELEMENT_ID = 'typeroll-runtime-config';

export interface FirebaseWebConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  appId?: string;
}

export interface PublicRuntimeConfig {
  firebase: FirebaseWebConfig;
}

const EMPTY_CONFIG: PublicRuntimeConfig = { firebase: {} };

export function parsePublicRuntimeConfig(serialized: string | null | undefined): PublicRuntimeConfig {
  if (!serialized) return EMPTY_CONFIG;
  try {
    const parsed = JSON.parse(serialized) as { firebase?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.firebase || typeof parsed.firebase !== 'object') {
      return EMPTY_CONFIG;
    }
    const firebase = parsed.firebase as Record<string, unknown>;
    return {
      firebase: {
        apiKey: typeof firebase.apiKey === 'string' ? firebase.apiKey : undefined,
        authDomain: typeof firebase.authDomain === 'string' ? firebase.authDomain : undefined,
        projectId: typeof firebase.projectId === 'string' ? firebase.projectId : undefined,
        appId: typeof firebase.appId === 'string' ? firebase.appId : undefined,
      },
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function readPublicRuntimeConfig(
  root: Pick<Document, 'getElementById'> = document,
): PublicRuntimeConfig {
  return parsePublicRuntimeConfig(
    root.getElementById(RUNTIME_CONFIG_ELEMENT_ID)?.textContent,
  );
}
