const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IMAGE_BY_DIGEST = /^\S+@sha256:[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const REQUIRED_GCP_APIS = Object.freeze([
  'artifactregistry.googleapis.com',
  'cloudscheduler.googleapis.com',
  'cloudtasks.googleapis.com',
  'firebase.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'identitytoolkit.googleapis.com',
  'run.googleapis.com',
  'secretmanager.googleapis.com',
]);

export const REQUIRED_SECRET_ENV = Object.freeze([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'EXTENSION_SIGNING_PRIVATE_JWK',
  'FORMS_HMAC_SECRET',
  'INTEGRATIONS_SECRET_KEY',
  'MCP_OAUTH_SIGNING_KEY',
  'PREVIEW_HMAC_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'R2_SECRET_ACCESS_KEY',
]);

const RESOURCE_KEYS = Object.freeze([
  'artifact_repository',
  'portal_service',
  'forms_service',
  'deploy_queue',
  'publish_scheduler',
  'portal_service_account',
  'forms_service_account',
  'internal_invoker_service_account',
]);

function stringAt(object, key) {
  return typeof object?.[key] === 'string' ? object[key].trim() : '';
}

function httpsOrigin(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.origin === input && !url.username && !url.password;
  } catch {
    return false;
  }
}

function placeholder(input) {
  return /(?:replace|your-|example\.com|<[^>]+>)/i.test(input);
}

export function validateGcpSelfHostConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['config: must be a JSON object'] };
  }
  if (config.schema_version !== 1) errors.push('schema_version: must equal 1');

  const projectId = stringAt(config, 'project_id');
  const region = stringAt(config, 'region');
  const image = stringAt(config, 'image');
  const digest = stringAt(config, 'image_digest');
  if (!PROJECT_ID.test(projectId) || placeholder(projectId)) errors.push('project_id: must be an explicit GCP project ID');
  if (!REGION.test(region)) errors.push('region: must be a GCP region such as europe-west1');
  if (!IMAGE_BY_DIGEST.test(image) || placeholder(image)) errors.push('image: must be an immutable OCI image reference with @sha256');
  if (!SHA256.test(digest) || placeholder(digest)) errors.push('image_digest: must be a lowercase sha256 digest');
  if (IMAGE_BY_DIGEST.test(image) && SHA256.test(digest) && !image.endsWith(`@${digest}`)) {
    errors.push('image_digest: must match image');
  }

  const firebaseApiKey = stringAt(config.firebase, 'api_key');
  const firebaseAuthDomain = stringAt(config.firebase, 'auth_domain').toLowerCase();
  const firebaseAppId = stringAt(config.firebase, 'app_id');
  if (!firebaseApiKey || placeholder(firebaseApiKey)) errors.push('firebase.api_key: missing Firebase Web API key');
  if (!HOSTNAME.test(firebaseAuthDomain) || placeholder(firebaseAuthDomain)) errors.push('firebase.auth_domain: must be an explicit hostname');
  if (!firebaseAppId || placeholder(firebaseAppId)) errors.push('firebase.app_id: missing Firebase Web App ID');

  const portalOrigin = stringAt(config.origins, 'portal');
  const formsOrigin = stringAt(config.origins, 'forms');
  const sitesBaseDomain = stringAt(config.origins, 'sites_base_domain').toLowerCase();
  if (!httpsOrigin(portalOrigin) || placeholder(portalOrigin)) errors.push('origins.portal: must be an explicit HTTPS origin');
  if (!httpsOrigin(formsOrigin) || placeholder(formsOrigin)) errors.push('origins.forms: must be an explicit HTTPS origin');
  if (portalOrigin && portalOrigin === formsOrigin) errors.push('origins.forms: must differ from origins.portal');
  if (!HOSTNAME.test(sitesBaseDomain) || placeholder(sitesBaseDomain)) errors.push('origins.sites_base_domain: must be an explicit DNS hostname');

  for (const key of RESOURCE_KEYS) {
    const input = stringAt(config.resources, key);
    if (!RESOURCE_NAME.test(input) || placeholder(input)) errors.push(`resources.${key}: invalid resource name`);
  }

  for (const envName of REQUIRED_SECRET_ENV) {
    const secretName = stringAt(config.secrets, envName);
    if (!SECRET_NAME.test(secretName) || placeholder(secretName)) {
      errors.push(`secrets.${envName}: missing or invalid Secret Manager name`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function serviceAccount(id, projectId) {
  return `${id}@${projectId}.iam.gserviceaccount.com`;
}

function secretBindings(names, selected) {
  return selected.map((envName) => ({ env: envName, secret: names[envName], version: 'latest' }));
}

export function buildGcpSelfHostPlan(config) {
  const validation = validateGcpSelfHostConfig(config);
  if (!validation.ok) throw new Error(`invalid GCP self-host config:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`);

  const { project_id: projectId, region, resources, secrets } = config;
  const portalServiceAccount = serviceAccount(resources.portal_service_account, projectId);
  const formsServiceAccount = serviceAccount(resources.forms_service_account, projectId);
  const internalInvoker = serviceAccount(resources.internal_invoker_service_account, projectId);
  const targetImage = `${region}-docker.pkg.dev/${projectId}/${resources.artifact_repository}/typeroll@${config.image_digest}`;
  const queuePath = `projects/${projectId}/locations/${region}/queues/${resources.deploy_queue}`;

  return {
    schema_version: 1,
    topology: 'gcp-firebase-serverless',
    project_id: projectId,
    region,
    release: {
      source_image: config.image,
      source_digest: config.image_digest,
      artifact_repository: resources.artifact_repository,
      mirrored_image: targetImage,
      rebuild: false,
    },
    required_tools: ['gcloud', 'crane'],
    required_apis: [...REQUIRED_GCP_APIS],
    service_accounts: [
      {
        purpose: 'portal-runtime',
        email: portalServiceAccount,
        project_roles: ['roles/cloudtasks.enqueuer', 'roles/datastore.user', 'roles/firebaseauth.admin'],
        secret_access: REQUIRED_SECRET_ENV.map((envName) => secrets[envName]),
        self_roles: ['roles/iam.serviceAccountTokenCreator'],
      },
      {
        purpose: 'forms-runtime',
        email: formsServiceAccount,
        project_roles: ['roles/datastore.user'],
        secret_access: [secrets.FORMS_HMAC_SECRET, secrets.INTEGRATIONS_SECRET_KEY],
        self_roles: [],
      },
      {
        purpose: 'internal-oidc-invoker',
        email: internalInvoker,
        project_roles: [],
        secret_access: [],
        self_roles: [],
        token_creators: ['cloud-tasks-service-agent', 'cloud-scheduler-service-agent'],
      },
    ],
    secrets: REQUIRED_SECRET_ENV.map((envName) => ({ env: envName, secret: secrets[envName], required_version: 'latest' })),
    cloud_run: {
      portal: {
        service: resources.portal_service,
        image: targetImage,
        service_account: portalServiceAccount,
        public: true,
        cpu: 1,
        memory: '1Gi',
        min_instances: 0,
        max_instances: 10,
        timeout_seconds: 900,
        concurrency: 50,
        env: {
          SERVICE_ROLE: 'portal',
          FIREBASE_PROJECT_ID: projectId,
          PUBLIC_FIREBASE_API_KEY: config.firebase.api_key,
          PUBLIC_FIREBASE_AUTH_DOMAIN: config.firebase.auth_domain,
          PUBLIC_FIREBASE_PROJECT_ID: projectId,
          PUBLIC_FIREBASE_APP_ID: config.firebase.app_id,
          PORTAL_PUBLIC_URL: config.origins.portal,
          FORMS_PUBLIC_URL: config.origins.forms,
          SITES_BASE_DOMAIN: config.origins.sites_base_domain,
          DEPLOY_QUEUE: 'cloud_tasks',
          CLOUD_TASKS_QUEUE: queuePath,
          CLOUD_TASKS_SERVICE_ACCOUNT: internalInvoker,
          DEPLOY_WORKER_URL: '$PORTAL_RUN_URL/api/internal/deploy-worker',
          TYPEROLL_IMAGE_DIGEST: config.image_digest,
        },
        secrets: secretBindings(secrets, REQUIRED_SECRET_ENV),
      },
      forms: {
        service: resources.forms_service,
        image: targetImage,
        service_account: formsServiceAccount,
        public: true,
        cpu: 1,
        memory: '512Mi',
        min_instances: 0,
        max_instances: 10,
        timeout_seconds: 60,
        concurrency: 80,
        env: {
          SERVICE_ROLE: 'forms',
          FIREBASE_PROJECT_ID: projectId,
          TYPEROLL_IMAGE_DIGEST: config.image_digest,
        },
        secrets: secretBindings(secrets, ['FORMS_HMAC_SECRET', 'INTEGRATIONS_SECRET_KEY']),
      },
    },
    cloud_tasks: {
      queue: resources.deploy_queue,
      path: queuePath,
      max_attempts: 3,
      max_concurrent_dispatches: 4,
      min_backoff: '30s',
      max_backoff: '300s',
      oidc_service_account: internalInvoker,
      target: '$PORTAL_RUN_URL/api/internal/deploy-worker',
      audience: '$PORTAL_RUN_URL/api/internal/deploy-worker',
    },
    cloud_scheduler: {
      job: resources.publish_scheduler,
      schedule: '*/5 * * * *',
      time_zone: 'Etc/UTC',
      method: 'POST',
      oidc_service_account: internalInvoker,
      target: '$PORTAL_RUN_URL/api/internal/publish-sweep',
      audience: '$PORTAL_RUN_URL/api/internal/deploy-worker',
    },
    forbidden_resources: ['compute-engine-vm', 'managed-instance-group', 'long-running-worker', 'reverse-proxy'],
  };
}
