import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGcpSelfHostPlan, REQUIRED_GCP_APIS, REQUIRED_SECRET_ENV, validateGcpSelfHostConfig } from './lib/self-host-gcp-plan.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

function config() {
  return {
    schema_version: 1,
    project_id: 'customer-typeroll',
    region: 'europe-west1',
    image: `ghcr.io/typeroll/typeroll@${digest}`,
    image_digest: digest,
    firebase: {
      api_key: 'public-firebase-api-key',
      auth_domain: 'auth.customer.test',
      app_id: '1:123:web:abc',
    },
    origins: {
      portal: 'https://cms.customer.test',
      forms: 'https://forms.customer.test',
      sites_base_domain: 'sites.customer.test',
    },
    resources: {
      artifact_repository: 'typeroll-core',
      portal_service: 'typeroll-portal',
      forms_service: 'typeroll-forms',
      deploy_queue: 'typeroll-deploy',
      publish_scheduler: 'typeroll-publish-sweep',
      portal_service_account: 'typeroll-portal',
      forms_service_account: 'typeroll-forms',
      internal_invoker_service_account: 'typeroll-internal-invoker',
    },
    secrets: Object.fromEntries(REQUIRED_SECRET_ENV.map((name) => [name, `typeroll-${name.toLowerCase().replaceAll('_', '-')}`])),
  };
}

test('accepts a complete customer-owned serverless config', () => {
  assert.deepEqual(validateGcpSelfHostConfig(config()), {
    ok: true,
    errors: [],
  });
});

test('requires immutable matching image identity and every secret reference', () => {
  const input = config();
  input.image = 'ghcr.io/typeroll/typeroll:latest';
  input.image_digest = `sha256:${'b'.repeat(64)}`;
  delete input.secrets.R2_BUCKET;

  const result = validateGcpSelfHostConfig(input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith('image:')));
  assert.ok(result.errors.some((error) => error.startsWith('secrets.R2_BUCKET:')));
});

test('plans Cloud Run, Tasks, and Scheduler without a VM or service-account key', () => {
  const plan = buildGcpSelfHostPlan(config());

  assert.equal(plan.topology, 'gcp-firebase-serverless');
  assert.equal(plan.release.rebuild, false);
  assert.equal(plan.release.mirror_tag.endsWith(`:sha256-${'a'.repeat(64)}`), true);
  assert.equal(plan.cloud_run.portal.env.FIREBASE_PROJECT_ID, 'customer-typeroll');
  assert.equal('FIREBASE_SERVICE_ACCOUNT' in plan.cloud_run.portal.env, false);
  assert.equal(plan.cloud_run.portal.env.DEPLOY_QUEUE, 'cloud_tasks');
  assert.equal(plan.cloud_tasks.target, '$PORTAL_RUN_URL/api/internal/deploy-worker');
  assert.equal(plan.cloud_scheduler.target, '$PORTAL_RUN_URL/api/internal/publish-sweep');
  assert.equal(plan.cloud_scheduler.audience, plan.cloud_tasks.audience);
  assert.deepEqual(plan.required_apis, [...REQUIRED_GCP_APIS]);
  assert.ok(plan.forbidden_resources.includes('compute-engine-vm'));
  assert.equal(JSON.stringify(plan).includes('FIREBASE_SERVICE_ACCOUNT'), false);
});

test('keeps runtime identities least-privileged and separated by service', () => {
  const plan = buildGcpSelfHostPlan(config());
  const portal = plan.service_accounts.find((account) => account.purpose === 'portal-runtime');
  const forms = plan.service_accounts.find((account) => account.purpose === 'forms-runtime');
  const invoker = plan.service_accounts.find((account) => account.purpose === 'internal-oidc-invoker');

  assert.ok(portal.project_roles.includes('roles/cloudtasks.enqueuer'));
  assert.ok(portal.project_roles.includes('roles/firebaseauth.admin'));
  assert.equal(portal.project_roles.includes('roles/secretmanager.secretAccessor'), false);
  assert.equal(portal.secret_access.length, REQUIRED_SECRET_ENV.length);
  assert.deepEqual(portal.self_roles, []);
  assert.equal(forms.project_roles.includes('roles/cloudtasks.enqueuer'), false);
  assert.deepEqual(forms.secret_access.sort(), [config().secrets.FORMS_HMAC_SECRET, config().secrets.INTEGRATIONS_SECRET_KEY].sort());
  assert.deepEqual(invoker.project_roles, []);
  assert.notEqual(portal.email, forms.email);
  assert.notEqual(portal.email, invoker.email);
  assert.deepEqual(plan.service_account_bindings, [
    {
      service_account: invoker.email,
      member: portal.email,
      roles: ['roles/iam.serviceAccountUser'],
      reason: 'portal creates Cloud Tasks that mint OIDC tokens as the internal invoker',
    },
  ]);
  assert.deepEqual(
    plan.service_agents.map((agent) => agent.project_roles[0]),
    ['roles/cloudtasks.serviceAgent', 'roles/cloudscheduler.serviceAgent'],
  );
});
