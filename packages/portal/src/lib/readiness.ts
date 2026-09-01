import { getStore } from './datastore';
import { serviceRole, type ServiceRole } from './release';

export type ReadinessState = 'pass' | 'fail' | 'disabled';

export interface ReadinessCheck {
  name: string;
  state: ReadinessState;
  required: boolean;
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  role: ServiceRole;
  checks: ReadinessCheck[];
}

type Probe = () => Promise<void>;

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function requirement(env: NodeJS.ProcessEnv, name: string, keys: string[], required = true): ReadinessCheck {
  const missing = keys.filter((key) => !present(env, key));
  if (!required) {
    return {
      name,
      state: missing.length === 0 ? 'pass' : 'disabled',
      required: false,
      detail: missing.length === 0 ? 'configured' : 'not configured',
    };
  }
  return {
    name,
    state: missing.length === 0 ? 'pass' : 'fail',
    required: true,
    detail: missing.length === 0 ? 'configured' : `missing ${missing.join(', ')}`,
  };
}

function firebaseAdminCheck(env: NodeJS.ProcessEnv, required: boolean): ReadinessCheck {
  const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) return requirement(env, 'firebase_admin', ['FIREBASE_SERVICE_ACCOUNT'], required);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const valid = Boolean(parsed.project_id && parsed.client_email && parsed.private_key);
    return {
      name: 'firebase_admin',
      state: valid ? 'pass' : 'fail',
      required,
      detail: valid ? 'configured' : 'service account JSON lacks required fields',
    };
  } catch {
    return {
      name: 'firebase_admin',
      state: 'fail',
      required,
      detail: 'service account is not valid JSON',
    };
  }
}

function queueCheck(env: NodeJS.ProcessEnv, role: ServiceRole): ReadinessCheck {
  if (role === 'forms') {
    return { name: 'deploy_queue', state: 'disabled', required: false, detail: 'not used by forms role' };
  }
  const mode = (env.DEPLOY_QUEUE ?? 'in_process').trim().toLowerCase();
  if (mode === 'in_process') {
    if (role === 'worker') {
      return { name: 'deploy_queue', state: 'fail', required: true, detail: 'worker role requires firestore or cloud_tasks' };
    }
    return { name: 'deploy_queue', state: 'pass', required: true, detail: 'in_process' };
  }
  if (mode === 'firestore') {
    return { name: 'deploy_queue', state: 'pass', required: true, detail: 'firestore' };
  }
  if (mode !== 'cloud_tasks') {
    return { name: 'deploy_queue', state: 'fail', required: true, detail: `unsupported mode ${mode}` };
  }
  const check = requirement(
    env,
    'deploy_queue',
    ['CLOUD_TASKS_QUEUE', 'DEPLOY_WORKER_URL', 'CLOUD_TASKS_SERVICE_ACCOUNT'],
  );
  return check.state === 'pass' ? { ...check, detail: 'cloud_tasks' } : check;
}

function configChecks(env: NodeJS.ProcessEnv): { role: ServiceRole; checks: ReadinessCheck[] } {
  const role = serviceRole(env);
  const production = env.NODE_ENV === 'production';
  const checks: ReadinessCheck[] = [firebaseAdminCheck(env, production)];

  if (role === 'portal') {
    checks.push(
      requirement(env, 'firebase_web', [
        'PUBLIC_FIREBASE_API_KEY',
        'PUBLIC_FIREBASE_AUTH_DOMAIN',
        'PUBLIC_FIREBASE_PROJECT_ID',
        'PUBLIC_FIREBASE_APP_ID',
      ], production),
      requirement(env, 'portal_public_url', ['PORTAL_PUBLIC_URL'], production),
      requirement(env, 'forms_signing', ['FORMS_HMAC_SECRET'], production),
    );
  } else if (role === 'forms') {
    checks.push(requirement(env, 'forms_signing', ['FORMS_HMAC_SECRET'], true));
  }

  checks.push(
    queueCheck(env, role),
    requirement(env, 'media_storage', [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_BASE_URL',
    ], false),
    requirement(env, 'site_hosting', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'], false),
  );
  return { role, checks };
}

async function defaultDatastoreProbe(): Promise<void> {
  await getStore().listDocs('organizations', { limit: 1 });
}

export async function readinessReport(
  env: NodeJS.ProcessEnv = process.env,
  probe: Probe = defaultDatastoreProbe,
): Promise<ReadinessReport> {
  const { role, checks } = configChecks(env);
  try {
    await probe();
    checks.push({ name: 'datastore', state: 'pass', required: true, detail: 'reachable' });
  } catch {
    checks.push({ name: 'datastore', state: 'fail', required: true, detail: 'unreachable' });
  }
  return {
    ready: checks.every((check) => !check.required || check.state === 'pass'),
    role,
    checks,
  };
}
