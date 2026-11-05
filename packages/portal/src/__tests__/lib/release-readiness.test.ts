import { describe, expect, it } from 'vitest';
import {
  CORE_VERSION,
  DATA_SCHEMA_VERSION,
  EXTENSION_HOST_PROTOCOL_VERSION,
  EXTENSION_RUNTIME_VERSION,
  SITE_TEMPLATE_CAPABILITIES,
} from '@typeroll/shared';
import { VERSION as MCP_VERSION } from '@typeroll/mcp-server/version';
import { readinessReport } from '../../lib/readiness';
import { releaseManifest } from '../../lib/release';

const firebaseAdmin = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@example.invalid',
  private_key: 'not-a-real-key',
});

function productionPortalEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    FIREBASE_SERVICE_ACCOUNT: firebaseAdmin,
    AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
    ACCOUNT_EMAIL: '{"type":"postmark","from":"Typeroll <no-reply@example.test>","config":{}}',
    PORTAL_PUBLIC_URL: 'https://portal.example.test',
    FORMS_HMAC_SECRET: 'test-only-secret',
    TYPEROLL_SCHEDULER: 'durable_object',
  };
}

describe('release manifest', () => {
  it('reports independently versioned artifact surfaces and identity', () => {
    expect(releaseManifest({
      SERVICE_ROLE: 'forms',
      TYPEROLL_SOURCE_SHA: 'abc123',
      TYPEROLL_BUNDLE_DIGEST: 'sha256:deadbeef',
    })).toEqual({
      core_version: CORE_VERSION,
      data_schema_version: DATA_SCHEMA_VERSION,
      data_schema_readable: { min: 2, max: 2 },
      template_capabilities_version: SITE_TEMPLATE_CAPABILITIES.template_capabilities_version,
      extension_host_protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
      extension_runtime_version: EXTENSION_RUNTIME_VERSION,
      mcp_version: MCP_VERSION,
      source_sha: 'abc123',
      bundle_digest: 'sha256:deadbeef',
      service_role: 'forms',
    });
  });
});

describe('readiness report', () => {
  it('passes a fully configured production portal', async () => {
    const report = await readinessReport(productionPortalEnv(), async () => undefined);

    expect(report.ready).toBe(true);
    expect(report.role).toBe('portal');
    expect(report.checks.find((check) => check.name === 'deploy_queue')?.detail).toBe('durable_object');
  });

  it('accepts keyless Firebase Admin credentials for Cloud Run', async () => {
    const env = productionPortalEnv();
    delete env.FIREBASE_SERVICE_ACCOUNT;
    env.FIREBASE_PROJECT_ID = 'test-project';

    const report = await readinessReport(env, async () => undefined);

    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.name === 'firebase_admin')?.detail)
      .toBe('application_default_credentials');
  });

  it('rejects conflicting Firebase Admin project IDs', async () => {
    const report = await readinessReport({
      ...productionPortalEnv(),
      FIREBASE_PROJECT_ID: 'different-project',
    }, async () => undefined);

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === 'firebase_admin')).toMatchObject({
      state: 'fail',
      detail: 'FIREBASE_PROJECT_ID does not match service account JSON',
    });
  });

  it('rejects an auth secret that is too short', async () => {
    const report = await readinessReport({ ...productionPortalEnv(), AUTH_SECRET: 'short' }, async () => undefined);

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === 'identity')).toMatchObject({ state: 'fail', detail: 'AUTH_SECRET must be at least 32 characters' });
    expect(JSON.stringify(report)).not.toContain('short');
  });

  it('reports missing production requirements without exposing their values', async () => {
    const report = await readinessReport({ NODE_ENV: 'production' }, async () => undefined);

    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => check.state === 'fail').map((check) => check.name)).toEqual([
      'firebase_admin',
      'identity',
      'account_email',
      'portal_public_url',
      'forms_signing',
      'deploy_queue',
    ]);
    expect(JSON.stringify(report)).not.toContain('test-only-secret');
    expect(JSON.stringify(report)).not.toContain('test-only-auth-secret');
  });

  it('fails when the datastore probe is unreachable', async () => {
    const report = await readinessReport(productionPortalEnv(), async () => {
      throw new Error('credential detail that must not escape');
    });

    expect(report.ready).toBe(false);
    expect(report.checks.at(-1)).toEqual({
      name: 'datastore',
      state: 'fail',
      required: true,
      detail: 'unreachable',
    });
    expect(JSON.stringify(report)).not.toContain('credential detail');
  });

  it('does not require browser or deploy configuration for the forms role', async () => {
    const report = await readinessReport({
      NODE_ENV: 'production',
      SERVICE_ROLE: 'forms',
      FIREBASE_SERVICE_ACCOUNT: firebaseAdmin,
      FORMS_HMAC_SECRET: 'test-only-secret',
    }, async () => undefined);

    expect(report.ready).toBe(true);
    expect(report.checks.some((check) => check.name === 'identity')).toBe(false);
    expect(report.checks.find((check) => check.name === 'deploy_queue')?.state).toBe('disabled');
  });

  it('requires the durable scheduler in production and accepts local timers in development', async () => {
    const local = await readinessReport({ ...productionPortalEnv(), TYPEROLL_SCHEDULER: 'local' }, async () => undefined);
    expect(local.ready).toBe(false);
    expect(local.checks.find((check) => check.name === 'deploy_queue')).toMatchObject({ state: 'fail', required: true });
    const typo = await readinessReport({ ...productionPortalEnv(), TYPEROLL_SCHEDULER: 'cloud_tasks' }, async () => undefined);
    expect(typo.checks.find((check) => check.name === 'deploy_queue')).toMatchObject({ state: 'fail', detail: 'unsupported TYPEROLL_SCHEDULER cloud_tasks' });
    const development = await readinessReport({ NODE_ENV: 'development' }, async () => undefined);
    expect(development.checks.find((check) => check.name === 'deploy_queue')).toMatchObject({ state: 'pass', detail: 'local' });
  });
});
