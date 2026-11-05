import { getStore } from './datastore';
import { requireCurrentDataSchema } from './data-schema';
import { serviceRole, type ServiceRole } from './release';
import { isIdentityConfigured } from './identity/portal-auth';
import { schedulingMode, type SchedulingMode } from './scheduling/transport';

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
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!raw) {
    const check = requirement(env, 'firebase_admin', ['FIREBASE_PROJECT_ID'], required);
    if (check.state !== 'pass') return check;
    return { ...check, detail: 'application_default_credentials' };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const valid = Boolean(parsed.project_id && parsed.client_email && parsed.private_key);
    const projectMatches = !projectId || parsed.project_id === projectId;
    return {
      name: 'firebase_admin',
      state: valid && projectMatches ? 'pass' : 'fail',
      required,
      detail: !valid
        ? 'service account JSON lacks required fields'
        : projectMatches
          ? 'service_account_json'
          : 'FIREBASE_PROJECT_ID does not match service account JSON',
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

function identityCheck(env: NodeJS.ProcessEnv, required: boolean): ReadinessCheck {
  const check = requirement(env, 'identity', ['AUTH_SECRET'], required);
  if (check.state !== 'pass') return check;
  return isIdentityConfigured(env)
    ? check
    : { name: 'identity', state: required ? 'fail' : 'disabled', required, detail: 'AUTH_SECRET must be at least 32 characters' };
}

/** Scheduled work and deploys are delivered by the scheduling transport (lib/scheduling/transport.ts). */
function queueCheck(env: NodeJS.ProcessEnv, role: ServiceRole): ReadinessCheck {
  if (role === 'forms') {
    return { name: 'deploy_queue', state: 'disabled', required: false, detail: 'not used by forms role' };
  }
  let mode: SchedulingMode;
  try { mode = schedulingMode(env); }
  catch { return { name: 'deploy_queue', state: 'fail', required: true, detail: `unsupported TYPEROLL_SCHEDULER ${env.TYPEROLL_SCHEDULER?.trim()}` }; }
  // Timers in one process lose accepted work on restart; production needs the durable transport.
  if (env.NODE_ENV === 'production' && mode !== 'durable_object') {
    return { name: 'deploy_queue', state: 'fail', required: true, detail: `${mode} scheduling is for development only; set TYPEROLL_SCHEDULER=durable_object` };
  }
  return { name: 'deploy_queue', state: 'pass', required: true, detail: mode };
}

function configChecks(env: NodeJS.ProcessEnv): { role: ServiceRole; checks: ReadinessCheck[] } {
  const role = serviceRole(env);
  const production = env.NODE_ENV === 'production';
  const checks: ReadinessCheck[] = [firebaseAdminCheck(env, production)];

  if (role === 'portal') {
    checks.push(
      identityCheck(env, production),
      requirement(env, 'account_email', ['ACCOUNT_EMAIL'], production),
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
  await requireCurrentDataSchema();
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
