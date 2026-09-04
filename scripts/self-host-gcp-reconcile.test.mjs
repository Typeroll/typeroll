import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGcpSelfHostPlan, REQUIRED_SECRET_ENV } from './lib/self-host-gcp-plan.mjs';
import {
  applyGcpSelfHostPlan,
  buildGcpSelfHostApplyPreview,
  doctorGcpSelfHostPlan,
} from './lib/self-host-gcp-reconcile.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

function plan() {
  return buildGcpSelfHostPlan({
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
    secrets: Object.fromEntries(
      REQUIRED_SECRET_ENV.map((name) => [name, `typeroll-${name.toLowerCase().replaceAll('_', '-')}`]),
    ),
  });
}

function fakeRunner(respond) {
  const calls = [];
  return {
    calls,
    run(command, args, options = {}) {
      const call = { command, args: [...args], options };
      calls.push(call);
      return (
        respond(call, calls.length - 1) ?? {
          exitCode: 0,
          stdout: '',
          stderr: '',
        }
      );
    },
  };
}

function hasArgs(call, ...values) {
  return values.every((value) => call.args.includes(value));
}

function activeProject(call) {
  if (call.command === 'gcloud' && hasArgs(call, 'projects', 'describe', 'customer-typeroll')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        projectId: 'customer-typeroll',
        projectNumber: '123456789',
        lifecycleState: 'ACTIVE',
      }),
      stderr: '',
    };
  }
  if (call.command === 'gcloud' && hasArgs(call, 'auth', 'list')) {
    return { exitCode: 0, stdout: 'operator@example.test\n', stderr: '' };
  }
  return null;
}

test('dry-run preview is local, explicit, and never claims to read secret values', () => {
  const preview = buildGcpSelfHostApplyPreview(plan());

  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.project_id, 'customer-typeroll');
  assert.equal(preview.apply_gate, '--apply --confirm-project customer-typeroll');
  assert.equal(preview.secret_values_read, false);
  assert.equal(preview.rebuild_image, false);
  assert.ok(preview.mutations.some((mutation) => mutation.includes('Cloud Run')));
});

test('apply rejects a mismatched project confirmation before executing a command', () => {
  const runner = fakeRunner(() => {
    throw new Error('runner must not be called');
  });

  assert.throws(
    () => applyGcpSelfHostPlan(plan(), { runner, confirmProject: 'wrong-project' }),
    /refusing remote mutation/,
  );
  assert.equal(runner.calls.length, 0);
});

test('foundation apply creates missing containers and converges IAM without secret access or compute resources', () => {
  const runner = fakeRunner((call) => {
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && call.args.includes('describe')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'ERROR: NOT_FOUND: resource was not found',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const events = [];

  const result = applyGcpSelfHostPlan(plan(), {
    phase: 'foundation',
    confirmProject: 'customer-typeroll',
    runner,
    log: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    ok: true,
    project_id: 'customer-typeroll',
    phase: 'foundation',
  });
  assert.ok(runner.calls.some((call) => hasArgs(call, 'services', 'enable')));
  assert.equal(runner.calls.filter((call) => hasArgs(call, 'secrets', 'create')).length, REQUIRED_SECRET_ENV.length);
  assert.ok(
    runner.calls.some((call) =>
      hasArgs(
        call,
        'service-accounts',
        'add-iam-policy-binding',
        'typeroll-internal-invoker@customer-typeroll.iam.gserviceaccount.com',
        '--member=serviceAccount:typeroll-portal@customer-typeroll.iam.gserviceaccount.com',
        '--role=roles/iam.serviceAccountUser',
      ),
    ),
  );
  const serialized = JSON.stringify(runner.calls);
  assert.equal(serialized.includes('versions","access'), false);
  assert.equal(serialized.includes('compute'), false);
  assert.equal(serialized.includes('run","deploy'), false);
  assert.ok(events.some((event) => event.resource === 'cloud-tasks-queue:typeroll-deploy'));
});

test('runtime apply fails closed before image or Cloud Run mutation when secret versions are missing', () => {
  const runner = fakeRunner((call) => {
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'versions', 'list')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  assert.throws(
    () =>
      applyGcpSelfHostPlan(plan(), {
        phase: 'runtime',
        confirmProject: 'customer-typeroll',
        runner,
      }),
    /enabled Secret Manager version/,
  );
  assert.equal(
    runner.calls.some((call) => call.command === 'crane' && call.args[0] === 'copy'),
    false,
  );
  assert.equal(
    runner.calls.some((call) => hasArgs(call, 'run', 'deploy')),
    false,
  );
});

test('runtime apply reuses a verified digest and converges both Cloud Run roles and Scheduler', () => {
  const portalUrl = 'https://typeroll-portal-abc-ew.a.run.app';
  const runner = fakeRunner((call) => {
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'versions', 'list')) {
      return {
        exitCode: 0,
        stdout: 'projects/123/secrets/example/versions/1\n',
        stderr: '',
      };
    }
    if (call.command === 'crane' && call.args[0] === 'digest') {
      return { exitCode: 0, stdout: `${digest}\n`, stderr: '' };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'run', 'services', 'describe', 'typeroll-portal')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: { url: portalUrl } }),
        stderr: '',
      };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'run', 'services', 'describe', 'typeroll-forms')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: { url: 'https://typeroll-forms-abc-ew.a.run.app' },
        }),
        stderr: '',
      };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'scheduler', 'jobs', 'describe')) {
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const result = applyGcpSelfHostPlan(plan(), {
    phase: 'runtime',
    confirmProject: 'customer-typeroll',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(
    runner.calls.some((call) => call.command === 'crane' && call.args[0] === 'copy'),
    false,
  );
  assert.equal(runner.calls.filter((call) => hasArgs(call, 'run', 'deploy')).length, 2);
  const portalDeploy = runner.calls.find((call) => hasArgs(call, 'run', 'deploy', 'typeroll-portal'));
  assert.ok(portalDeploy.args.some((arg) => arg.includes(`DEPLOY_WORKER_URL=${portalUrl}/api/internal/deploy-worker`)));
  const scheduler = runner.calls.find((call) => hasArgs(call, 'scheduler', 'jobs', 'update', 'http'));
  assert.ok(scheduler.args.includes(`--uri=${portalUrl}/api/internal/publish-sweep`));
  assert.ok(scheduler.args.includes(`--oidc-token-audience=${portalUrl}/api/internal/deploy-worker`));
});

test('runtime apply bootstraps Cloud Run when gcloud reports Cannot find service', () => {
  const portalUrl = 'https://typeroll-portal-bootstrap-ew.a.run.app';
  let portalInspections = 0;
  const runner = fakeRunner((call) => {
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'versions', 'list')) {
      return { exitCode: 0, stdout: 'projects/123/secrets/example/versions/1\n', stderr: '' };
    }
    if (call.command === 'crane' && call.args[0] === 'digest') {
      return { exitCode: 0, stdout: `${digest}\n`, stderr: '' };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'run', 'services', 'describe', 'typeroll-portal')) {
      portalInspections += 1;
      return portalInspections === 1
        ? { exitCode: 1, stdout: '', stderr: 'ERROR: Cannot find service [typeroll-portal]' }
        : { exitCode: 0, stdout: JSON.stringify({ status: { url: portalUrl } }), stderr: '' };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'run', 'services', 'describe', 'typeroll-forms')) {
      return { exitCode: 1, stdout: '', stderr: 'ERROR: Cannot find service [typeroll-forms]' };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'scheduler', 'jobs', 'describe')) {
      return { exitCode: 1, stdout: '', stderr: 'ERROR: NOT_FOUND: Job not found' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const result = applyGcpSelfHostPlan(plan(), {
    phase: 'runtime',
    confirmProject: 'customer-typeroll',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(runner.calls.filter((call) => hasArgs(call, 'run', 'deploy', 'typeroll-portal')).length, 2);
  assert.equal(runner.calls.filter((call) => hasArgs(call, 'run', 'deploy', 'typeroll-forms')).length, 1);
  assert.ok(runner.calls.some((call) => hasArgs(call, 'scheduler', 'jobs', 'create', 'http')));
});

test('doctor remains read-only and reports missing tools and enabled secret versions without values', () => {
  const currentPlan = plan();
  const runner = fakeRunner((call) => {
    if (call.command === 'crane') return { exitCode: 127, stdout: '', stderr: 'command not found' };
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && hasArgs(call, 'services', 'list')) {
      return {
        exitCode: 0,
        stdout: `${currentPlan.required_apis.join('\n')}\n`,
        stderr: '',
      };
    }
    if (
      call.command === 'gcloud' &&
      hasArgs(call, 'iam', 'service-accounts', 'describe') &&
      call.args.some((arg) => arg.includes('@gcp-sa-'))
    ) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'PERMISSION_DENIED: Permission iam.serviceAccounts.get denied',
      };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'versions', 'list')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: 'present\n', stderr: '' };
  });

  const result = doctorGcpSelfHostPlan(currentPlan, { runner });

  assert.equal(result.ok, false);
  assert.equal(result.secret_values_read, false);
  assert.equal(result.checks.find((check) => check.id === 'tool.crane').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'secret.R2_BUCKET').detail, 'no enabled version exists');
  assert.equal(JSON.stringify(runner.calls).includes('versions","access'), false);
  assert.equal(
    runner.calls.some((call) =>
      call.args.some((arg) => ['create', 'update', 'deploy', 'enable', 'add-iam-policy-binding'].includes(arg)),
    ),
    false,
  );
});

test('doctor verifies the complete IAM and control-plane contract', () => {
  const currentPlan = plan();
  const projectNumber = '123456789';
  const policy = (bindings) => ({
    exitCode: 0,
    stdout: JSON.stringify({ bindings }),
    stderr: '',
  });
  const runner = fakeRunner((call) => {
    if (call.command === 'gcloud' && call.args[0] === '--version') {
      return { exitCode: 0, stdout: 'Google Cloud SDK 579.0.0\n', stderr: '' };
    }
    if (call.command === 'crane' && call.args[0] === 'version') {
      return { exitCode: 0, stdout: 'v0.20.6\n', stderr: '' };
    }
    if (call.command === 'crane' && call.args[0] === 'digest') {
      return { exitCode: 0, stdout: `${digest}\n`, stderr: '' };
    }
    const project = activeProject(call);
    if (project) return project;
    if (call.command === 'gcloud' && hasArgs(call, 'services', 'list')) {
      return {
        exitCode: 0,
        stdout: `${currentPlan.required_apis.join('\n')}\n`,
        stderr: '',
      };
    }
    if (call.command === 'gcloud' && hasArgs(call, 'projects', 'get-iam-policy')) {
      const bindings = currentPlan.service_accounts.flatMap((account) =>
        account.project_roles.map((role) => ({
          role,
          members: [`serviceAccount:${account.email}`],
        })),
      );
      bindings.push(
        ...currentPlan.service_agents.flatMap((agent) =>
          agent.project_roles.map((role) => ({
            role,
            members: [`serviceAccount:${agent.email.replace('$PROJECT_NUMBER', projectNumber)}`],
          })),
        ),
      );
      return policy(bindings);
    }
    if (call.command === 'gcloud' && hasArgs(call, 'service-accounts', 'get-iam-policy')) {
      const binding = currentPlan.service_account_bindings[0];
      return policy(
        binding.roles.map((role) => ({
          role,
          members: [`serviceAccount:${binding.member}`],
        })),
      );
    }
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'get-iam-policy')) {
      const secret = call.args[call.args.indexOf('get-iam-policy') + 1];
      const members = currentPlan.service_accounts
        .filter((account) => account.secret_access.includes(secret))
        .map((account) => `serviceAccount:${account.email}`);
      return policy([{ role: 'roles/secretmanager.secretAccessor', members }]);
    }
    if (call.command === 'gcloud' && hasArgs(call, 'run', 'services', 'get-iam-policy')) {
      return policy([{ role: 'roles/run.invoker', members: ['allUsers'] }]);
    }
    if (call.command === 'gcloud' && hasArgs(call, 'secrets', 'versions', 'list')) {
      return {
        exitCode: 0,
        stdout: 'projects/123/secrets/example/versions/1\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: 'present\n', stderr: '' };
  });

  const result = doctorGcpSelfHostPlan(currentPlan, { runner });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.id === 'iam.project').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'iam.secret.R2_BUCKET').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'iam.cloud-run.portal').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'service-agent.cloud-tasks-service-agent').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'service-agent.cloud-scheduler-service-agent').status, 'pass');
  assert.equal(
    runner.calls.some(
      (call) =>
        hasArgs(call, 'iam', 'service-accounts', 'describe') &&
        call.args.some((arg) => arg.includes('@gcp-sa-')),
    ),
    false,
  );
});
