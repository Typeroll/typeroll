import { getStore, storeBackend, type StoreBackend } from './datastore';
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

/**
 * The document store this process serves. Deployed Workers must run on the
 * Durable Object store in the EU jurisdiction; STORE_JURISDICTION=none exists
 * only for local workerd, so it passes only on a localhost portal. Fixtures and
 * a local SQLite file are development backends.
 */
function datastoreRuntimeCheck(env: NodeJS.ProcessEnv, backend: StoreBackend, required: boolean): ReadinessCheck {
  const name = 'datastore_runtime';
  if (backend !== 'durable_object') {
    return required
      ? { name, state: 'fail', required, detail: `${backend} is for development only; deploy the Worker with its Durable Object store` }
      : { name, state: 'pass', required, detail: backend };
  }
  const jurisdiction = env.STORE_JURISDICTION?.trim() || 'eu';
  if (jurisdiction === 'eu') return { name, state: 'pass', required, detail: 'durable_object (eu)' };
  if (jurisdiction === 'none' && isLocalPortal(env)) return { name, state: 'pass', required, detail: 'durable_object (local, no jurisdiction)' };
  return { name, state: required ? 'fail' : 'disabled', required, detail: `STORE_JURISDICTION ${jurisdiction} is not allowed; deployed stores use eu` };
}

function isLocalPortal(env: NodeJS.ProcessEnv): boolean {
  try {
    const url = new URL(env.PORTAL_PUBLIC_URL?.trim() ?? '');
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
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

function configChecks(env: NodeJS.ProcessEnv, backend: StoreBackend): { role: ServiceRole; checks: ReadinessCheck[] } {
  const role = serviceRole(env);
  const production = env.NODE_ENV === 'production';
  const checks: ReadinessCheck[] = [datastoreRuntimeCheck(env, backend, production)];

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
  backend: StoreBackend = storeBackend(env),
): Promise<ReadinessReport> {
  const { role, checks } = configChecks(env, backend);
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
