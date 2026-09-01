import type { App, ServiceAccount } from 'firebase-admin/app';

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw || undefined;
}

export function firebaseAdminProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = value(env, 'FIREBASE_PROJECT_ID');
  const raw = value(env, 'FIREBASE_SERVICE_ACCOUNT');
  if (!raw) return explicit;

  try {
    const credentials = JSON.parse(raw) as { project_id?: unknown };
    return explicit ?? (typeof credentials.project_id === 'string' ? credentials.project_id : undefined);
  } catch {
    return explicit;
  }
}

export function isFirebaseAdminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(value(env, 'FIREBASE_SERVICE_ACCOUNT') || value(env, 'FIREBASE_PROJECT_ID'));
}

/**
 * Returns the shared Firebase Admin app.
 *
 * Cloud Run uses Application Default Credentials from its attached service
 * account and only needs FIREBASE_PROJECT_ID. Portable deployments can retain
 * the FIREBASE_SERVICE_ACCOUNT JSON escape hatch.
 */
export async function getFirebaseAdminApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const { applicationDefault, cert, getApps, initializeApp } = await import('firebase-admin/app');
  const existing = getApps()[0];
  if (existing) return existing;

  const projectId = firebaseAdminProjectId(env);
  if (!projectId) {
    throw new Error('Firebase Admin requires FIREBASE_PROJECT_ID or FIREBASE_SERVICE_ACCOUNT');
  }

  const raw = value(env, 'FIREBASE_SERVICE_ACCOUNT');
  if (raw) {
    const credentials = JSON.parse(raw) as ServiceAccount & { project_id?: string };
    if (credentials.project_id && credentials.project_id !== projectId) {
      throw new Error('FIREBASE_PROJECT_ID must match FIREBASE_SERVICE_ACCOUNT.project_id');
    }
    return initializeApp({ credential: cert(credentials), projectId });
  }

  return initializeApp({ credential: applicationDefault(), projectId });
}
