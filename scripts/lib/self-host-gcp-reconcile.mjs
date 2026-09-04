import { spawnSync } from 'node:child_process';

const APPLY_PHASES = Object.freeze(['foundation', 'runtime', 'all']);
const NOT_FOUND = /(?:NOT_FOUND|cannot find|not (?:be )?found|does not exist|was not found)/i;

function commandLabel(command, args) {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:@=,-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

export function createCommandRunner() {
  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        input: options.input,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error?.code === 'ENOENT') {
        return {
          exitCode: 127,
          stdout: '',
          stderr: `${command}: command not found`,
        };
      }
      if (result.error) throw result.error;
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

function checked(runner, command, args, options = {}) {
  const result = runner.run(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n').at(-1) || `exit ${result.exitCode}`;
    throw new Error(`${commandLabel(command, args)} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function gcloud(projectId, ...args) {
  return [...args, `--project=${projectId}`, '--quiet'];
}

function serviceAgentEmail(template, projectNumber) {
  return template.replace('$PROJECT_NUMBER', projectNumber);
}

function inspectResource(runner, command, args) {
  const result = runner.run(command, args);
  if (result.exitCode === 0) return { exists: true, stdout: result.stdout.trim() };
  if (NOT_FOUND.test(result.stderr)) return { exists: false, stdout: '' };
  const detail = result.stderr.trim().split('\n').at(-1) || `exit ${result.exitCode}`;
  throw new Error(`${commandLabel(command, args)} failed while inspecting: ${detail}`);
}

function emit(log, action, resource) {
  log({ action, resource });
}

function ensureServiceAccount(runner, plan, account, log) {
  const args = gcloud(plan.project_id, 'iam', 'service-accounts', 'describe', account.email, '--format=json');
  const current = inspectResource(runner, 'gcloud', args);
  if (current.exists) {
    emit(log, 'unchanged', `service-account:${account.email}`);
    return;
  }
  const id = account.email.split('@')[0];
  checked(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'iam', 'service-accounts', 'create', id, `--display-name=Typeroll ${account.purpose}`),
  );
  emit(log, 'created', `service-account:${account.email}`);
}

function addProjectBinding(runner, projectId, member, role, log) {
  checked(
    runner,
    'gcloud',
    gcloud(
      projectId,
      'projects',
      'add-iam-policy-binding',
      projectId,
      `--member=serviceAccount:${member}`,
      `--role=${role}`,
      '--condition=None',
    ),
  );
  emit(log, 'converged', `project-iam:${member}:${role}`);
}

function addServiceAccountBinding(runner, projectId, serviceAccount, member, role, log) {
  checked(
    runner,
    'gcloud',
    gcloud(
      projectId,
      'iam',
      'service-accounts',
      'add-iam-policy-binding',
      serviceAccount,
      `--member=serviceAccount:${member}`,
      `--role=${role}`,
      '--condition=None',
    ),
  );
  emit(log, 'converged', `service-account-iam:${serviceAccount}:${member}:${role}`);
}

function ensureSecret(runner, plan, secret, log) {
  const inspect = inspectResource(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'secrets', 'describe', secret, '--format=json'),
  );
  if (!inspect.exists) {
    checked(
      runner,
      'gcloud',
      gcloud(plan.project_id, 'secrets', 'create', secret, '--labels=managed-by=typeroll-self-host'),
    );
    emit(log, 'created', `secret-container:${secret}`);
  } else {
    emit(log, 'unchanged', `secret-container:${secret}`);
  }
}

function addSecretBinding(runner, projectId, secret, member, log) {
  checked(
    runner,
    'gcloud',
    gcloud(
      projectId,
      'secrets',
      'add-iam-policy-binding',
      secret,
      `--member=serviceAccount:${member}`,
      '--role=roles/secretmanager.secretAccessor',
      '--condition=None',
    ),
  );
  emit(log, 'converged', `secret-iam:${secret}:${member}`);
}

function ensureArtifactRepository(runner, plan, log) {
  const repository = plan.release.artifact_repository;
  const inspect = inspectResource(
    runner,
    'gcloud',
    gcloud(
      plan.project_id,
      'artifacts',
      'repositories',
      'describe',
      repository,
      `--location=${plan.region}`,
      '--format=json',
    ),
  );
  if (inspect.exists) {
    emit(log, 'unchanged', `artifact-repository:${repository}`);
    return;
  }
  checked(
    runner,
    'gcloud',
    gcloud(
      plan.project_id,
      'artifacts',
      'repositories',
      'create',
      repository,
      `--location=${plan.region}`,
      '--repository-format=docker',
      '--description=Typeroll immutable Core image mirror',
    ),
  );
  emit(log, 'created', `artifact-repository:${repository}`);
}

function queueArgs(plan) {
  return [
    `--location=${plan.region}`,
    `--max-attempts=${plan.cloud_tasks.max_attempts}`,
    `--max-concurrent-dispatches=${plan.cloud_tasks.max_concurrent_dispatches}`,
    `--min-backoff=${plan.cloud_tasks.min_backoff}`,
    `--max-backoff=${plan.cloud_tasks.max_backoff}`,
  ];
}

function ensureQueue(runner, plan, log) {
  const queue = plan.cloud_tasks.queue;
  const inspect = inspectResource(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'tasks', 'queues', 'describe', queue, `--location=${plan.region}`, '--format=json'),
  );
  const operation = inspect.exists ? 'update' : 'create';
  checked(runner, 'gcloud', gcloud(plan.project_id, 'tasks', 'queues', operation, queue, ...queueArgs(plan)));
  emit(log, inspect.exists ? 'converged' : 'created', `cloud-tasks-queue:${queue}`);
}

function enabledSecretVersions(runner, plan, secret) {
  return checked(
    runner,
    'gcloud',
    gcloud(
      plan.project_id,
      'secrets',
      'versions',
      'list',
      secret,
      '--filter=state=ENABLED',
      '--limit=1',
      '--format=value(name)',
    ),
  );
}

function requireSecretVersions(runner, plan) {
  const missing = plan.secrets
    .filter(({ secret }) => !enabledSecretVersions(runner, plan, secret))
    .map(({ env }) => env);
  if (missing.length > 0) {
    throw new Error(`runtime apply requires an enabled Secret Manager version for: ${missing.join(', ')}`);
  }
}

function ensureMirroredImage(runner, plan, log) {
  const current = runner.run('crane', ['digest', plan.release.mirrored_image]);
  if (current.exitCode === 0 && current.stdout.trim() === plan.release.source_digest) {
    emit(log, 'unchanged', `image:${plan.release.mirrored_image}`);
    return;
  }
  checked(runner, 'gcloud', ['auth', 'configure-docker', `${plan.region}-docker.pkg.dev`, '--quiet']);
  checked(runner, 'crane', ['copy', plan.release.source_image, plan.release.mirror_tag]);
  const mirroredDigest = checked(runner, 'crane', ['digest', plan.release.mirror_tag]);
  if (mirroredDigest !== plan.release.source_digest) {
    throw new Error(
      `mirrored image digest mismatch: expected ${plan.release.source_digest}, got ${mirroredDigest || '(empty)'}`,
    );
  }
  const digestReference = checked(runner, 'crane', ['digest', plan.release.mirrored_image]);
  if (digestReference !== plan.release.source_digest) {
    throw new Error(`mirrored digest reference is unavailable after copy: ${plan.release.mirrored_image}`);
  }
  emit(log, 'copied', `image:${plan.release.mirrored_image}`);
}

function encodedEnv(env) {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function encodedSecrets(secrets) {
  return secrets.map(({ env, secret, version }) => `${env}=${secret}:${version}`).join(',');
}

function cloudRunDeployArgs(plan, service, workerUrl) {
  const env = Object.fromEntries(
    Object.entries(service.env).map(([name, value]) => [
      name,
      value === '$PORTAL_RUN_URL/api/internal/deploy-worker' ? workerUrl : value,
    ]),
  );
  return gcloud(
    plan.project_id,
    'run',
    'deploy',
    service.service,
    `--region=${plan.region}`,
    `--image=${service.image}`,
    `--service-account=${service.service_account}`,
    `--cpu=${service.cpu}`,
    `--memory=${service.memory}`,
    `--min-instances=${service.min_instances}`,
    `--max-instances=${service.max_instances}`,
    `--timeout=${service.timeout_seconds}s`,
    `--concurrency=${service.concurrency}`,
    `--set-env-vars=${encodedEnv(env)}`,
    `--set-secrets=${encodedSecrets(service.secrets)}`,
    '--allow-unauthenticated',
  );
}

function inspectCloudRun(runner, plan, serviceName) {
  return inspectResource(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'run', 'services', 'describe', serviceName, `--region=${plan.region}`, '--format=json'),
  );
}

function cloudRunUrl(description, serviceName) {
  if (!description.exists) return '';
  const resource = parseJson(description.stdout, `Cloud Run service ${serviceName}`);
  return resource?.status?.url || '';
}

function deployCloudRun(runner, plan, log) {
  const portal = plan.cloud_run.portal;
  const existing = inspectCloudRun(runner, plan, portal.service);
  const bootstrapWorkerUrl = `${portal.env.PORTAL_PUBLIC_URL}/api/internal/deploy-worker`;
  const existingUrl = cloudRunUrl(existing, portal.service);
  checked(
    runner,
    'gcloud',
    cloudRunDeployArgs(plan, portal, existingUrl ? `${existingUrl}/api/internal/deploy-worker` : bootstrapWorkerUrl),
  );
  emit(log, existing.exists ? 'converged' : 'created', `cloud-run:${portal.service}`);

  const deployed = inspectCloudRun(runner, plan, portal.service);
  const portalRunUrl = cloudRunUrl(deployed, portal.service);
  if (!portalRunUrl) throw new Error(`Cloud Run service ${portal.service} did not report status.url`);
  const desiredWorkerUrl = `${portalRunUrl}/api/internal/deploy-worker`;
  if (!existingUrl) {
    checked(runner, 'gcloud', cloudRunDeployArgs(plan, portal, desiredWorkerUrl));
    emit(log, 'converged', `cloud-run:${portal.service}:internal-url`);
  }

  const forms = plan.cloud_run.forms;
  const formsExisting = inspectCloudRun(runner, plan, forms.service);
  checked(runner, 'gcloud', cloudRunDeployArgs(plan, forms, desiredWorkerUrl));
  emit(log, formsExisting.exists ? 'converged' : 'created', `cloud-run:${forms.service}`);
  return { portalRunUrl, desiredWorkerUrl };
}

function schedulerArgs(plan, targetUrl, audience) {
  const scheduler = plan.cloud_scheduler;
  return [
    `--location=${plan.region}`,
    `--schedule=${scheduler.schedule}`,
    `--time-zone=${scheduler.time_zone}`,
    `--uri=${targetUrl}`,
    `--http-method=${scheduler.method}`,
    `--oidc-service-account-email=${scheduler.oidc_service_account}`,
    `--oidc-token-audience=${audience}`,
  ];
}

function ensureScheduler(runner, plan, portalRunUrl, workerUrl, log) {
  const job = plan.cloud_scheduler.job;
  const inspect = inspectResource(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'scheduler', 'jobs', 'describe', job, `--location=${plan.region}`, '--format=json'),
  );
  const operation = inspect.exists ? 'update' : 'create';
  const target = `${portalRunUrl}/api/internal/publish-sweep`;
  checked(
    runner,
    'gcloud',
    gcloud(plan.project_id, 'scheduler', 'jobs', operation, 'http', job, ...schedulerArgs(plan, target, workerUrl)),
  );
  emit(log, inspect.exists ? 'converged' : 'created', `cloud-scheduler:${job}`);
}

export function buildGcpSelfHostApplyPreview(plan, phase = 'all') {
  if (!APPLY_PHASES.includes(phase)) throw new Error(`phase must be one of: ${APPLY_PHASES.join(', ')}`);
  const foundation = [
    `enable ${plan.required_apis.length} required APIs`,
    `create or reuse ${plan.service_accounts.length} runtime identities`,
    `create or reuse Artifact Registry repository ${plan.release.artifact_repository}`,
    `create or converge Cloud Tasks queue ${plan.cloud_tasks.queue}`,
    `create or reuse ${plan.secrets.length} empty Secret Manager containers`,
    'converge project, service-account, and per-secret IAM bindings',
  ];
  const runtime = [
    'require one enabled version for every referenced secret without reading secret values',
    `copy ${plan.release.source_image} to Artifact Registry without rebuilding`,
    `deploy Cloud Run services ${plan.cloud_run.portal.service} and ${plan.cloud_run.forms.service}`,
    `create or converge Cloud Scheduler job ${plan.cloud_scheduler.job}`,
  ];
  return {
    mode: 'dry-run',
    project_id: plan.project_id,
    region: plan.region,
    phase,
    mutations: phase === 'foundation' ? foundation : phase === 'runtime' ? runtime : [...foundation, ...runtime],
    apply_gate: `--apply --confirm-project ${plan.project_id}`,
    secret_values_read: false,
    rebuild_image: false,
  };
}

export function applyGcpSelfHostPlan(plan, options = {}) {
  const phase = options.phase ?? 'all';
  if (!APPLY_PHASES.includes(phase)) throw new Error(`phase must be one of: ${APPLY_PHASES.join(', ')}`);
  if (options.confirmProject !== plan.project_id) {
    throw new Error(`refusing remote mutation: --confirm-project must exactly equal ${plan.project_id}`);
  }

  const runner = options.runner ?? createCommandRunner();
  const log = options.log ?? (() => {});
  checked(runner, 'gcloud', ['--version']);
  if (phase !== 'foundation') checked(runner, 'crane', ['version']);

  const project = parseJson(
    checked(
      runner,
      'gcloud',
      gcloud(
        plan.project_id,
        'projects',
        'describe',
        plan.project_id,
        '--format=json(projectId,projectNumber,lifecycleState)',
      ),
    ),
    'gcloud projects describe',
  );
  if (project.projectId !== plan.project_id || project.lifecycleState !== 'ACTIVE' || !project.projectNumber) {
    throw new Error(
      `target project ${plan.project_id} is missing, inactive, or did not match the explicit confirmation`,
    );
  }
  if (!checked(runner, 'gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)', '--limit=1'])) {
    throw new Error('gcloud has no active account');
  }
  emit(log, 'verified', `project:${plan.project_id}`);

  if (phase !== 'runtime') {
    checked(runner, 'gcloud', gcloud(plan.project_id, 'services', 'enable', ...plan.required_apis));
    emit(log, 'converged', `apis:${plan.required_apis.length}`);

    for (const account of plan.service_accounts) ensureServiceAccount(runner, plan, account, log);
    ensureArtifactRepository(runner, plan, log);
    ensureQueue(runner, plan, log);

    for (const account of plan.service_accounts) {
      for (const role of account.project_roles) addProjectBinding(runner, plan.project_id, account.email, role, log);
    }
    for (const agent of plan.service_agents) {
      const email = serviceAgentEmail(agent.email, project.projectNumber);
      for (const role of agent.project_roles) addProjectBinding(runner, plan.project_id, email, role, log);
    }
    for (const binding of plan.service_account_bindings) {
      for (const role of binding.roles) {
        addServiceAccountBinding(runner, plan.project_id, binding.service_account, binding.member, role, log);
      }
    }
    for (const { secret } of plan.secrets) ensureSecret(runner, plan, secret, log);
    for (const account of plan.service_accounts) {
      for (const secret of account.secret_access) addSecretBinding(runner, plan.project_id, secret, account.email, log);
    }
  }

  if (phase !== 'foundation') {
    requireSecretVersions(runner, plan);
    emit(log, 'verified', `secret-versions:${plan.secrets.length}`);
    ensureMirroredImage(runner, plan, log);
    const { portalRunUrl, desiredWorkerUrl } = deployCloudRun(runner, plan, log);
    ensureScheduler(runner, plan, portalRunUrl, desiredWorkerUrl, log);
  }

  return { ok: true, project_id: plan.project_id, phase };
}

function doctorCheck(checks, id, result, passDetail, options = {}) {
  if (result.exitCode === 0 && (options.allowEmpty || result.stdout.trim())) {
    checks.push({ id, status: 'pass', detail: passDetail });
    return result.stdout.trim();
  }
  const detail =
    result.exitCode === 127
      ? 'required command is not installed'
      : result.exitCode === 0
        ? 'command returned no matching resource'
        : 'resource is missing or inaccessible';
  checks.push({ id, status: 'fail', detail });
  return '';
}

function policyHas(policy, role, member) {
  return policy?.bindings?.some((binding) => binding.role === role && binding.members?.includes(member)) ?? false;
}

function doctorPolicyCheck(checks, id, result, expectations) {
  if (result.exitCode !== 0) {
    checks.push({
      id,
      status: 'fail',
      detail: 'IAM policy is missing or inaccessible',
    });
    return;
  }
  try {
    const policy = JSON.parse(result.stdout);
    const missing = expectations.filter(({ role, member }) => !policyHas(policy, role, member));
    checks.push({
      id,
      status: missing.length === 0 ? 'pass' : 'fail',
      detail:
        missing.length === 0
          ? 'required IAM bindings are present'
          : `missing ${missing.length} required IAM binding(s)`,
    });
  } catch {
    checks.push({
      id,
      status: 'fail',
      detail: 'IAM policy metadata was not valid JSON',
    });
  }
}

export function doctorGcpSelfHostPlan(plan, options = {}) {
  const runner = options.runner ?? createCommandRunner();
  const checks = [];
  doctorCheck(checks, 'tool.gcloud', runner.run('gcloud', ['--version']), 'gcloud is available');
  doctorCheck(checks, 'tool.crane', runner.run('crane', ['version']), 'crane is available');

  const projectOutput = doctorCheck(
    checks,
    'project.active',
    runner.run(
      'gcloud',
      gcloud(
        plan.project_id,
        'projects',
        'describe',
        plan.project_id,
        '--format=json(projectId,projectNumber,lifecycleState)',
      ),
    ),
    `project ${plan.project_id} is accessible`,
  );
  let projectNumber = '';
  if (projectOutput) {
    try {
      const project = JSON.parse(projectOutput);
      projectNumber = String(project.projectNumber ?? '');
      if (project.projectId !== plan.project_id || project.lifecycleState !== 'ACTIVE' || !projectNumber) {
        checks.at(-1).status = 'fail';
        checks.at(-1).detail = 'project identity or lifecycle state does not match the plan';
      }
    } catch {
      checks.at(-1).status = 'fail';
      checks.at(-1).detail = 'project metadata was not valid JSON';
    }
  }

  const enabled = doctorCheck(
    checks,
    'apis.enabled',
    runner.run('gcloud', gcloud(plan.project_id, 'services', 'list', '--enabled', '--format=value(config.name)')),
    'required API state is readable',
  );
  if (enabled) {
    const names = new Set(enabled.split(/\s+/));
    const missing = plan.required_apis.filter((name) => !names.has(name));
    if (missing.length > 0) {
      checks.at(-1).status = 'fail';
      checks.at(-1).detail = `missing ${missing.length} required API(s)`;
    }
  }

  for (const account of plan.service_accounts) {
    doctorCheck(
      checks,
      `service-account.${account.purpose}`,
      runner.run(
        'gcloud',
        gcloud(plan.project_id, 'iam', 'service-accounts', 'describe', account.email, '--format=value(email)'),
      ),
      `${account.purpose} identity exists`,
    );
  }
  const projectExpectations = plan.service_accounts.flatMap((account) =>
    account.project_roles.map((role) => ({
      role,
      member: `serviceAccount:${account.email}`,
    })),
  );
  if (projectNumber) {
    projectExpectations.push(
      ...plan.service_agents.flatMap((agent) => {
        const email = serviceAgentEmail(agent.email, projectNumber);
        return agent.project_roles.map((role) => ({
          role,
          member: `serviceAccount:${email}`,
        }));
      }),
    );
  }
  const projectPolicy = runner.run(
    'gcloud',
    gcloud(plan.project_id, 'projects', 'get-iam-policy', plan.project_id, '--format=json'),
  );
  doctorPolicyCheck(
    checks,
    'iam.project',
    projectPolicy,
    projectExpectations,
  );
  if (projectNumber) {
    for (const agent of plan.service_agents) {
      const email = serviceAgentEmail(agent.email, projectNumber);
      doctorPolicyCheck(
        checks,
        `service-agent.${agent.purpose}`,
        projectPolicy,
        agent.project_roles.map((role) => ({
          role,
          member: `serviceAccount:${email}`,
        })),
      );
    }
  }

  for (const binding of plan.service_account_bindings) {
    doctorPolicyCheck(
      checks,
      `iam.service-account.${binding.service_account}`,
      runner.run(
        'gcloud',
        gcloud(plan.project_id, 'iam', 'service-accounts', 'get-iam-policy', binding.service_account, '--format=json'),
      ),
      binding.roles.map((role) => ({
        role,
        member: `serviceAccount:${binding.member}`,
      })),
    );
  }

  doctorCheck(
    checks,
    'artifact.repository',
    runner.run(
      'gcloud',
      gcloud(
        plan.project_id,
        'artifacts',
        'repositories',
        'describe',
        plan.release.artifact_repository,
        `--location=${plan.region}`,
        '--format=value(name)',
      ),
    ),
    'Artifact Registry repository exists',
  );

  doctorCheck(
    checks,
    'cloud-tasks.queue',
    runner.run(
      'gcloud',
      gcloud(
        plan.project_id,
        'tasks',
        'queues',
        'describe',
        plan.cloud_tasks.queue,
        `--location=${plan.region}`,
        '--format=value(name)',
      ),
    ),
    'Cloud Tasks queue exists',
  );

  for (const { env, secret } of plan.secrets) {
    const enabledVersion = doctorCheck(
      checks,
      `secret.${env}`,
      runner.run(
        'gcloud',
        gcloud(
          plan.project_id,
          'secrets',
          'versions',
          'list',
          secret,
          '--filter=state=ENABLED',
          '--limit=1',
          '--format=value(name)',
        ),
      ),
      'secret metadata is readable',
      { allowEmpty: true },
    );
    if (checks.at(-1).status === 'pass' && !enabledVersion) {
      checks.at(-1).status = 'fail';
      checks.at(-1).detail = 'no enabled version exists';
    }
    const accessors = plan.service_accounts
      .filter((account) => account.secret_access.includes(secret))
      .map((account) => ({
        role: 'roles/secretmanager.secretAccessor',
        member: `serviceAccount:${account.email}`,
      }));
    doctorPolicyCheck(
      checks,
      `iam.secret.${env}`,
      runner.run('gcloud', gcloud(plan.project_id, 'secrets', 'get-iam-policy', secret, '--format=json')),
      accessors,
    );
  }

  const image = runner.run('crane', ['digest', plan.release.mirrored_image]);
  doctorCheck(checks, 'image.digest', image, 'mirrored image is readable by digest');
  if (image.exitCode === 0 && image.stdout.trim() !== plan.release.source_digest) {
    checks.at(-1).status = 'fail';
    checks.at(-1).detail = 'mirrored image digest does not match the release';
  }

  for (const [role, service] of Object.entries(plan.cloud_run)) {
    doctorCheck(
      checks,
      `cloud-run.${role}`,
      runner.run(
        'gcloud',
        gcloud(
          plan.project_id,
          'run',
          'services',
          'describe',
          service.service,
          `--region=${plan.region}`,
          '--format=value(status.url)',
        ),
      ),
      `${role} Cloud Run service is ready`,
    );
    doctorPolicyCheck(
      checks,
      `iam.cloud-run.${role}`,
      runner.run(
        'gcloud',
        gcloud(
          plan.project_id,
          'run',
          'services',
          'get-iam-policy',
          service.service,
          `--region=${plan.region}`,
          '--format=json',
        ),
      ),
      [{ role: 'roles/run.invoker', member: 'allUsers' }],
    );
  }
  doctorCheck(
    checks,
    'cloud-scheduler.publish-sweep',
    runner.run(
      'gcloud',
      gcloud(
        plan.project_id,
        'scheduler',
        'jobs',
        'describe',
        plan.cloud_scheduler.job,
        `--location=${plan.region}`,
        '--format=value(name)',
      ),
    ),
    'publish sweep scheduler exists',
  );

  return {
    ok: checks.every((check) => check.status === 'pass'),
    project_id: plan.project_id,
    secret_values_read: false,
    checks,
  };
}
