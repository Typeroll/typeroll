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
    PUBLIC_FIREBASE_API_KEY: 'public-api-key',
    PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
    PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
    PUBLIC_FIREBASE_APP_ID: 'test-app',
    PORTAL_PUBLIC_URL: 'https://portal.example.test',
    FORMS_HMAC_SECRET: 'test-only-secret',
    DEPLOY_QUEUE: 'cloud_tasks',
    CLOUD_TASKS_QUEUE: 'projects/test/locations/test/queues/deploy',
    DEPLOY_WORKER_URL: 'https://worker.example.test/api/internal/deploy-worker',
    CLOUD_TASKS_SERVICE_ACCOUNT: 'worker@example.invalid',
  };
}

describe('release manifest', () => {
  it('reports independently versioned artifact surfaces and identity', () => {
    expect(releaseManifest({
      SERVICE_ROLE: 'forms',
      TYPEROLL_SOURCE_SHA: 'abc123',
      TYPEROLL_IMAGE_DIGEST: 'sha256:deadbeef',
    })).toEqual({
      core_version: CORE_VERSION,
      data_schema_version: DATA_SCHEMA_VERSION,
      data_schema_readable: { min: 1, max: 1 },
      template_capabilities_version: SITE_TEMPLATE_CAPABILITIES.template_capabilities_version,
      extension_host_protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
      extension_runtime_version: EXTENSION_RUNTIME_VERSION,
      mcp_version: MCP_VERSION,
      source_sha: 'abc123',
      image_digest: 'sha256:deadbeef',
      service_role: 'forms',
    });
  });
});

describe('readiness report', () => {
  it('passes a fully configured production portal', async () => {
    const report = await readinessReport(productionPortalEnv(), async () => undefined);

    expect(report.ready).toBe(true);
    expect(report.role).toBe('portal');
    expect(report.checks.find((check) => check.name === 'deploy_queue')?.detail).toBe('cloud_tasks');
  });

  it('reports missing production requirements without exposing their values', async () => {
    const report = await readinessReport({ NODE_ENV: 'production' }, async () => undefined);

    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => check.state === 'fail').map((check) => check.name)).toEqual([
      'firebase_admin',
      'firebase_web',
      'portal_public_url',
      'forms_signing',
    ]);
    expect(JSON.stringify(report)).not.toContain('test-only-secret');
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
    expect(report.checks.some((check) => check.name === 'firebase_web')).toBe(false);
    expect(report.checks.find((check) => check.name === 'deploy_queue')?.state).toBe('disabled');
  });

  it('accepts the Firestore queue for the self-hosted portal and worker roles', async () => {
    const portal = await readinessReport({
      ...productionPortalEnv(),
      DEPLOY_QUEUE: 'firestore',
    }, async () => undefined);
    const worker = await readinessReport({
      NODE_ENV: 'production',
      SERVICE_ROLE: 'worker',
      FIREBASE_SERVICE_ACCOUNT: firebaseAdmin,
      DEPLOY_QUEUE: 'firestore',
    }, async () => undefined);

    expect(portal.ready).toBe(true);
    expect(portal.checks.find((check) => check.name === 'deploy_queue')?.detail).toBe('firestore');
    expect(worker.ready).toBe(true);
    expect(worker.role).toBe('worker');
  });

  it('rejects an in-process queue for the worker role', async () => {
    const report = await readinessReport({
      NODE_ENV: 'production',
      SERVICE_ROLE: 'worker',
      FIREBASE_SERVICE_ACCOUNT: firebaseAdmin,
      DEPLOY_QUEUE: 'in_process',
    }, async () => undefined);

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === 'deploy_queue')).toMatchObject({
      state: 'fail',
      required: true,
    });
  });
});
