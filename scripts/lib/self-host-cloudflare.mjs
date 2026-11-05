// The Cloudflare self-host profile: install a released Core Worker bundle in
// the self-hoster's own Cloudflare account.
//
// The bundle is the one Typeroll Cloud deploys (scripts/release-worker-bundle.mjs):
// verified by digest and GitHub build provenance, extracted unchanged, and
// uploaded with a wrangler configuration derived from the one the build
// generated. The derivation adds names, origins, EU R2 buckets and public
// variables and removes what the platform forbids; bindings, Durable Object
// migrations and the entry module stay as built. Secrets go to Cloudflare by
// name from a 0600 file or the environment and are never printed.
//
// Every side effect goes through injected dependencies (`deps`), so the tests
// run without wrangler, gh or the network.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { assetNames, extractBundle, verifyBundle } from '../release-worker-bundle.mjs';
import { SELF_HOST_CORE_VERSION } from './self-host-schema.mjs';

export const CORE_REPOSITORY = 'Typeroll/typeroll';
export const SIGNER_WORKFLOW = `${CORE_REPOSITORY}/.github/workflows/publish-mcp.yml`;
/** The deployer's token. Kept apart from the runtime's own CLOUDFLARE_API_TOKEN secret. */
export const DEPLOY_TOKEN_ENV = 'CLOUDFLARE_DEPLOY_API_TOKEN';
/**
 * R2 bindings the bundle may declare, and the configured bucket each gets.
 * MIGRATION holds exports and import checkpoints (lib/migration/worker-run.ts);
 * here it is the backups bucket, so a restore reads the backup from there.
 */
export const R2_BINDINGS = { MIGRATION: 'backups' };

// Secrets each script reads, by name. Values never appear in plans or logs.
export const SECRETS = {
  portal: {
    required: [
      'ACCOUNT_EMAIL',
      'AUTH_SECRET',
      'EXTENSION_SIGNING_PRIVATE_JWK',
      'FORMS_HMAC_SECRET',
      'INTEGRATIONS_SECRET_KEY',
      'MCP_OAUTH_SIGNING_KEY',
      'PREVIEW_HMAC_SECRET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ],
    optional: [
      'CLOUDFLARE_API_TOKEN',
      'EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS',
      'GITHUB_SIGNIN_CLIENT_ID',
      'GITHUB_SIGNIN_CLIENT_SECRET',
      'PAGESPEED_API_KEY',
      'SCRAPER_API_KEY',
      'TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET',
      'TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET',
      'TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY',
      'TYPEROLL_STORE_TRANSFER_TOKEN',
    ],
  },
  forms: {
    required: ['AUTH_SECRET', 'EXTENSION_SIGNING_PRIVATE_JWK', 'FORMS_HMAC_SECRET', 'INTEGRATIONS_SECRET_KEY'],
    optional: [],
  },
};
export const ROLES = ['portal', 'forms'];
const ALL_SECRETS = new Set(ROLES.flatMap(role => [...SECRETS[role].required, ...SECRETS[role].optional]));

// Variables the profile sets itself; `vars` in the config cannot replace them.
const RESERVED_VARS = new Set([
  'CLOUDFLARE_ACCOUNT_ID', 'FORMS_PUBLIC_URL', 'PORTAL_PUBLIC_URL', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_PRIVATE_BUCKET',
  'R2_PUBLIC_BASE_URL', 'SERVICE_ROLE', 'SITES_BASE_DOMAIN', 'STORE_JURISDICTION', 'TYPEROLL_BUNDLE_DIGEST',
  'TYPEROLL_RUNTIME', 'TYPEROLL_SCHEDULER', 'TYPEROLL_SOURCE_SHA', 'TYPEROLL_STORE_BOOTSTRAP',
]);

// Keys the Cloudflare Vite plugin writes for local tooling; they mean nothing to an upload.
const LOCAL_KEYS = ['configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments', 'dev', 'previews'];
// Workers Logs and traces store data outside the EU. Logs leave through Logpush to EU R2 instead.
const OBSERVABILITY = { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } };

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

export class SelfHostError extends Error {}

function httpsOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new SelfHostError(`${label} must be an https URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new SelfHostError(`${label} must be an https origin without a path, credentials or query`);
  }
  return url.origin;
}

/**
 * The self-host configuration file (`self-host.cloudflare.json`). Only names
 * and public identifiers belong in it; secrets live in the secrets file.
 */
export function validateSelfHostConfig(raw, { defaultCoreVersion = SELF_HOST_CORE_VERSION } = {}) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SelfHostError('The self-host configuration must be a JSON object');
  const known = new Set(['$schema', 'account_id', 'core_version', 'bundle_sha256', 'name_prefix', 'portal_host', 'forms_host',
    'workers_subdomain', 'buckets', 'media_public_url', 'sites_base_domain', 'logpush', 'vars']);
  for (const key of Object.keys(raw)) check(known.has(key), `unknown setting ${key}`);
  check(ACCOUNT_ID.test(raw.account_id ?? ''), 'account_id must be a 32-character Cloudflare account ID');
  const coreVersion = raw.core_version ?? defaultCoreVersion;
  check(VERSION.test(coreVersion ?? ''), 'core_version must be a released Core version (x.y.z)');
  check(raw.bundle_sha256 === undefined || DIGEST.test(raw.bundle_sha256), 'bundle_sha256 must be sha256:<64 hex>');
  const prefix = raw.name_prefix ?? 'typeroll';
  check(SCRIPT_NAME.test(prefix), 'name_prefix must be lowercase letters, digits and hyphens');
  for (const key of ['portal_host', 'forms_host', 'sites_base_domain']) {
    check(raw[key] === undefined || HOSTNAME.test(raw[key]), `${key} must be a lowercase hostname`);
  }
  check(Boolean(raw.portal_host) === Boolean(raw.forms_host), 'set both portal_host and forms_host, or neither (workers.dev)');
  check(raw.portal_host === undefined || raw.portal_host !== raw.forms_host, 'Forms needs its own hostname');
  check(raw.portal_host || /^[a-z0-9-]+$/.test(raw.workers_subdomain ?? ''), 'without custom hostnames, workers_subdomain (your <name>.workers.dev) is required');
  const buckets = {
    media: raw.buckets?.media ?? `${prefix}-media`,
    private_drafts: raw.buckets?.private_drafts ?? `${prefix}-private-drafts`,
    backups: raw.buckets?.backups ?? `${prefix}-backups`,
  };
  for (const key of Object.keys(raw.buckets ?? {})) check(key in buckets, `unknown bucket ${key}`);
  for (const [key, name] of Object.entries(buckets)) check(BUCKET_NAME.test(name), `buckets.${key} must be a valid R2 bucket name`);
  check(new Set(Object.values(buckets)).size === 3, 'media, private_drafts and backups must be three different buckets');
  let mediaPublicUrl = null;
  try { mediaPublicUrl = httpsOrigin(raw.media_public_url, 'media_public_url'); } catch (error) { errors.push(error.message); }
  check(raw.logpush === undefined || typeof raw.logpush === 'boolean', 'logpush must be true or false');
  const vars = raw.vars ?? {};
  check(typeof vars === 'object' && !Array.isArray(vars), 'vars must be an object');
  for (const [name, value] of Object.entries(vars)) {
    check(VAR_NAME.test(name), `vars.${name} must be an upper-case variable name`);
    check(!RESERVED_VARS.has(name), `vars.${name} is set by the profile`);
    check(!ALL_SECRETS.has(name), `vars.${name} is a secret; put it in the secrets file`);
    check(typeof value === 'string', `vars.${name} must be a string`);
  }
  if (errors.length) throw new SelfHostError(`The self-host configuration is invalid:\n- ${errors.join('\n- ')}`);
  return {
    accountId: raw.account_id,
    coreVersion,
    bundleSha256: raw.bundle_sha256 ?? null,
    scripts: { portal: `${prefix}-portal`, forms: `${prefix}-forms` },
    hosts: raw.portal_host ? { portal: raw.portal_host, forms: raw.forms_host } : null,
    workersSubdomain: raw.workers_subdomain ?? null,
    buckets,
    mediaPublicUrl,
    sitesBaseDomain: raw.sites_base_domain ?? null,
    logpush: raw.logpush === true,
    vars: { ...vars },
  };
}

export function readSelfHostConfig(file, options) {
  if (!fs.existsSync(file)) throw new SelfHostError(`No self-host configuration at ${file}; copy config/self-host-cloudflare.example.json`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new SelfHostError(`${file} is not valid JSON`); }
  return validateSelfHostConfig(raw, options);
}

/** Secret values by name, from a dotenv file only readable by its owner, or from the environment. */
export function readSecrets({ file, env = process.env, platform = process.platform }) {
  let source = env;
  if (file) {
    if (!fs.existsSync(file)) throw new SelfHostError(`No secrets file at ${file}`);
    if (platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) throw new SelfHostError(`${path.basename(file)} must be readable by its owner only (chmod 600)`);
    source = parseEnv(fs.readFileSync(file, 'utf8'));
  }
  const secrets = {};
  for (const name of ALL_SECRETS) {
    const value = source[name]?.trim();
    if (value) secrets[name] = value;
  }
  return secrets;
}

export function originsFor(config) {
  if (config.hosts) return { portal: `https://${config.hosts.portal}`, forms: `https://${config.hosts.forms}` };
  return Object.fromEntries(ROLES.map(role => [role, `https://${config.scripts[role]}.${config.workersSubdomain}.workers.dev`]));
}

/** Required and optional secret names per script, including those the bundle itself requires. */
export function secretNames(contract) {
  return Object.fromEntries(ROLES.map(role => [role, {
    required: [...new Set([...SECRETS[role].required, ...(role === 'portal' ? contract.secrets_required ?? [] : [])])].sort(),
    optional: [...SECRETS[role].optional].sort(),
  }]));
}

// ─── Bundle ───────────────────────────────────────────────────────────────

/**
 * The release bundle for `config.coreVersion`: from `bundleDir` when it holds
 * the tarball and descriptor, otherwise downloaded from the Core GitHub
 * release with `gh`. Verified by digest, inventory and release contract, then
 * by its GitHub build provenance, before anything uses it.
 */
export async function obtainBundle({ config, bundleDir, workDir, deps }) {
  const names = assetNames(config.coreVersion);
  let dir = bundleDir;
  const present = d => d && fs.existsSync(path.join(d, names.tarball)) && fs.existsSync(path.join(d, names.descriptor));
  if (!present(dir)) {
    dir = path.join(workDir, 'bundle');
    fs.mkdirSync(dir, { recursive: true });
    await deps.run('gh', ['release', 'download', `core-v${config.coreVersion}`, '--repo', CORE_REPOSITORY,
      '--pattern', names.tarball, '--pattern', names.descriptor, '--dir', dir, '--clobber']);
    if (!present(dir)) throw new SelfHostError(`Core ${config.coreVersion} has no Worker bundle on its release`);
  }
  const tarballPath = path.join(dir, names.tarball);
  const tarball = fs.readFileSync(tarballPath);
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(path.join(dir, names.descriptor), 'utf8')); } catch { throw new SelfHostError(`${names.descriptor} is not valid JSON`); }
  let release;
  try {
    release = verifyBundle(tarball, descriptor, { core_version: config.coreVersion, ...(config.bundleSha256 ? { sha256: config.bundleSha256 } : {}) });
  } catch (error) {
    throw new SelfHostError(`The Worker bundle failed verification: ${error.message}`);
  }
  await verifyAttestation({ tarballPath, deps });
  return { tarball, tarballPath, descriptor, release, digest: descriptor.sha256 };
}

/** The provenance check Core's release runs before it tags, and Cloud runs before it deploys. */
export async function verifyAttestation({ tarballPath, deps }) {
  try {
    await deps.run('gh', ['attestation', 'verify', tarballPath, '--repo', CORE_REPOSITORY,
      '--signer-workflow', SIGNER_WORKFLOW, '--source-ref', 'refs/heads/main',
      '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners']);
  } catch (error) {
    throw new SelfHostError(`The Worker bundle has no valid GitHub build provenance from ${SIGNER_WORKFLOW}: ${error.message}`);
  }
}

// ─── Configuration ────────────────────────────────────────────────────────

function baseFrom(generated, config, role, origins) {
  const derived = structuredClone(generated);
  for (const key of LOCAL_KEYS) delete derived[key];
  delete derived.placement;
  return {
    ...derived,
    name: config.scripts[role],
    account_id: config.accountId,
    workers_dev: !config.hosts,
    // Per-version preview URLs would publish every upload on workers.dev.
    preview_urls: false,
    routes: config.hosts ? [{ pattern: new URL(origins[role]).host, custom_domain: true }] : [],
    observability: OBSERVABILITY,
    logpush: config.logpush,
  };
}

/** Rebind self service bindings (the Scheduler) to the portal script; refuse any other. */
function serviceBindings(generated, portalScript) {
  return (generated.services ?? []).map(service => {
    if (service.service !== generated.name) throw new SelfHostError(`The bundle binds service ${service.service}, which the self-host profile does not provide`);
    return { ...service, service: portalScript };
  });
}

/**
 * The portal and Forms configurations for the self-hoster's account, derived
 * from the bundle's generated wrangler.json and its release contract.
 */
export function deriveSelfHostConfigs({ config, generated, release, digest }) {
  const contract = release.workers?.portal;
  if (!contract) throw new SelfHostError('The bundle has no portal Worker contract');
  if (generated.main !== contract.main || JSON.stringify(generated.migrations ?? []) !== JSON.stringify(contract.migrations)) {
    throw new SelfHostError('The bundled wrangler.json does not match the bundle release contract');
  }
  const origins = originsFor(config);
  const release_vars = {
    STORE_JURISDICTION: 'eu',
    TYPEROLL_SOURCE_SHA: release.source_sha,
    TYPEROLL_BUNDLE_DIGEST: digest,
    PORTAL_PUBLIC_URL: origins.portal,
    FORMS_PUBLIC_URL: origins.forms,
    // A new installation records its data schema in its empty store on the
    // first request to either Worker; an existing one keeps its record
    // (lib/data-schema.ts).
    TYPEROLL_STORE_BOOTSTRAP: 'empty',
  };
  const r2 = (contract.bindings?.r2_buckets ?? []).map(binding => {
    if (!R2_BINDINGS[binding]) throw new SelfHostError(`The bundle declares an R2 binding ${binding} that the self-host profile does not provide`);
    return { binding, bucket_name: config.buckets[R2_BINDINGS[binding]], jurisdiction: 'eu' };
  });

  const portal = baseFrom(generated, config, 'portal', origins);
  portal.vars = {
    ...generated.vars,
    ...config.vars,
    ...release_vars,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    R2_ACCOUNT_ID: config.accountId,
    R2_BUCKET: config.buckets.media,
    R2_PRIVATE_BUCKET: config.buckets.private_drafts,
    R2_PUBLIC_BASE_URL: config.mediaPublicUrl,
    ...(config.sitesBaseDomain ? { SITES_BASE_DOMAIN: config.sitesBaseDomain } : {}),
  };
  portal.r2_buckets = r2;
  portal.services = serviceBindings(generated, config.scripts.portal);
  portal.triggers = { crons: [...contract.crons] };

  // Forms is the same bundle as a second script, reaching the portal's store
  // objects through script_name. It owns no migrations, crons or buckets.
  const forms = baseFrom(generated, config, 'forms', origins);
  forms.vars = { ...generated.vars, ...config.vars, ...release_vars, SERVICE_ROLE: 'forms' };
  forms.durable_objects = { bindings: (generated.durable_objects?.bindings ?? []).map(binding => ({ ...binding, script_name: config.scripts.portal })) };
  delete forms.migrations;
  forms.r2_buckets = [];
  forms.services = serviceBindings(generated, config.scripts.portal);
  forms.triggers = { crons: [] };
  if (forms.assets) forms.assets = { ...forms.assets, run_worker_first: true };

  const configs = { portal, forms };
  for (const role of ROLES) {
    const errors = validateDerivedConfig(configs[role], role, config);
    if (errors.length) throw new SelfHostError(`${config.scripts[role]} configuration is not allowed:\n- ${errors.join('\n- ')}`);
  }
  return { configs, origins };
}

/** The EU isolation rules every self-hosted script must satisfy. */
export function validateDerivedConfig(derived, role, config) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(derived.name === config.scripts[role], `name must be ${config.scripts[role]}`);
  check(derived.account_id === config.accountId, 'account_id must be the configured account');
  check(derived.observability?.enabled === false && derived.observability.logs?.enabled === false && derived.observability.traces?.enabled === false, 'Workers Logs and traces must be off');
  check(!derived.placement, 'Smart Placement must be off');
  check(!(derived.kv_namespaces ?? []).length, 'KV is not allowed');
  check(!(derived.d1_databases ?? []).length, 'D1 is not part of the Core Worker');
  check((derived.r2_buckets ?? []).every(bucket => bucket.jurisdiction === 'eu'), 'every R2 bucket must be bound in jurisdiction eu');
  check(derived.vars?.STORE_JURISDICTION === 'eu', 'STORE_JURISDICTION must be eu');
  check(derived.preview_urls === false, 'preview URLs must be off');
  check(!LOCAL_KEYS.some(key => key in derived), 'local build keys must be removed');
  check(Object.keys(derived.vars ?? {}).every(name => !ALL_SECRETS.has(name)), 'secrets must not be plain variables');
  if (role === 'portal') check((derived.triggers?.crons ?? []).length > 0, 'the portal runs the Cron sweep');
  else check(!(derived.triggers?.crons ?? []).length && !(derived.migrations ?? []).length, 'Forms owns no crons or migrations');
  return errors;
}

/** Extract the bundle and write both derived configurations next to the generated one. */
export function prepareBundle({ bundle, config, workDir }) {
  const extracted = path.join(workDir, 'extracted');
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  extractBundle(bundle.tarball, extracted);
  const serverDir = path.join(extracted, 'portal/server');
  const generated = JSON.parse(fs.readFileSync(path.join(serverDir, 'wrangler.json'), 'utf8'));
  const { configs, origins } = deriveSelfHostConfigs({ config, generated, release: bundle.release, digest: bundle.digest });
  // Next to the generated file, so main, assets and module rules resolve as built.
  const configPaths = {};
  for (const role of ROLES) {
    configPaths[role] = path.join(serverDir, `wrangler.self-host.${role}.json`);
    fs.writeFileSync(configPaths[role], `${JSON.stringify(configs[role], null, 2)}\n`);
  }
  return { configs, configPaths, origins };
}

// ─── Account state ────────────────────────────────────────────────────────

/** Read-only view of the account: buckets, scripts, their migration tag and secret names. */
export async function inspectAccount({ config, deps }) {
  const buckets = {};
  for (const [key, name] of Object.entries(config.buckets)) {
    const { status, body } = await deps.api(`/accounts/${config.accountId}/r2/buckets/${name}`, { 'cf-r2-jurisdiction': 'eu' });
    if (status === 404) buckets[key] = { name, state: 'missing' };
    else if (body?.success) buckets[key] = { name, state: body.result?.jurisdiction && body.result.jurisdiction !== 'eu' ? 'wrong_jurisdiction' : 'present' };
    else throw new SelfHostError(`Cloudflare could not describe bucket ${name}: HTTP ${status}`);
  }
  const scripts = {};
  for (const role of ROLES) {
    const name = config.scripts[role];
    const { status, body } = await deps.api(`/accounts/${config.accountId}/workers/services/${name}`);
    if (status === 404) { scripts[role] = { name, exists: false, migration_tag: null, secrets: [] }; continue; }
    if (!body?.success) throw new SelfHostError(`Cloudflare could not describe ${name}: HTTP ${status}`);
    const secrets = JSON.parse(await deps.wrangler(['secret', 'list', '--name', name, '--format', 'json'])).map(secret => secret.name);
    scripts[role] = { name, exists: true, migration_tag: body.result?.default_environment?.script?.migration_tag ?? null, secrets };
  }
  return { buckets, scripts };
}

/** How a script is uploaded: atomically for a first deployment or a Durable Object migration, else as a version. */
export function uploadMode(role, script, contract) {
  if (!script.exists) return { mode: 'deploy', reason: 'first deployment' };
  if (role === 'portal' && script.migration_tag !== contract.migration_tag) {
    const known = contract.migrations.map(migration => migration.tag);
    if (script.migration_tag && !known.includes(script.migration_tag)) {
      throw new SelfHostError(`${script.name} has Durable Object migration ${script.migration_tag}, which this bundle does not know; it would run code older than its stored schema`);
    }
    return { mode: 'deploy', reason: `Durable Object migration ${script.migration_tag ?? '<none>'} -> ${contract.migration_tag}` };
  }
  return { mode: 'version', reason: 'same Durable Object schema' };
}

/** Everything apply would do, with no change. Secret values never appear, only names. */
export function buildPlan({ config, bundle, account, secrets, origins }) {
  const contract = bundle.release.workers.portal;
  const names = secretNames(contract);
  const scripts = {};
  const problems = [];
  for (const role of ROLES) {
    const script = account.scripts[role];
    const present = new Set(script.secrets);
    const missing = names[role].required.filter(name => !secrets[name] && !present.has(name));
    if (missing.length) problems.push(`${script.name} is missing required secrets: ${missing.join(', ')}`);
    scripts[role] = {
      name: script.name, origin: origins[role], ...uploadMode(role, script, contract),
      secrets_to_set: [...names[role].required, ...names[role].optional].filter(name => secrets[name]),
      secrets_missing: missing,
    };
  }
  for (const bucket of Object.values(account.buckets)) {
    if (bucket.state === 'wrong_jurisdiction') problems.push(`Bucket ${bucket.name} exists outside the EU jurisdiction; choose another name`);
  }
  return {
    core_version: bundle.release.core_version,
    bundle_digest: bundle.digest,
    source_sha: bundle.release.source_sha,
    migration_tag: contract.migration_tag,
    buckets: Object.fromEntries(Object.entries(account.buckets).map(([key, bucket]) => [key, { name: bucket.name, action: bucket.state === 'missing' ? 'create (eu)' : bucket.state }])),
    scripts,
    problems,
  };
}

function versionMessage(bundle) {
  return `typeroll core ${bundle.release.core_version} bundle ${bundle.digest.slice(7, 19)} mig ${bundle.release.workers.portal.migration_tag}`.slice(0, 100);
}

/** Write the secrets one script may receive into a 0600 JSON file (JSON: no $VAR expansion). */
function writeSecretsFile(workDir, role, secrets) {
  const names = [...SECRETS[role].required, ...SECRETS[role].optional].filter(name => secrets[name]);
  if (!names.length) return null;
  const file = path.join(workDir, `secrets.${role}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(names.map(name => [name, secrets[name]]))), { mode: 0o600 });
  return file;
}

/**
 * Create the EU buckets, then upload and deploy the portal (it owns the
 * Durable Object class) and Forms. Secrets travel with the upload through a
 * temporary 0600 file that is removed afterwards.
 */
export async function applySelfHost({ config, bundle, prepared, plan, secrets, workDir, deps, log = () => {} }) {
  if (plan.problems.length) throw new SelfHostError(`Apply stopped before any change:\n- ${plan.problems.join('\n- ')}`);
  for (const bucket of Object.values(plan.buckets)) {
    if (bucket.action !== 'create (eu)') continue;
    log(`creating R2 bucket ${bucket.name} (eu)`);
    await deps.wrangler(['r2', 'bucket', 'create', bucket.name, '--jurisdiction', 'eu']);
  }
  const message = versionMessage(bundle);
  const deployed = {};
  const secretDir = fs.mkdtempSync(path.join(workDir, 'secrets-'));
  try {
    for (const role of ROLES) {
      const step = plan.scripts[role];
      const secretsFile = writeSecretsFile(secretDir, role, secrets);
      const secretArgs = secretsFile ? ['--secrets-file', secretsFile] : [];
      if (step.mode === 'deploy') {
        log(`deploying ${step.name} (${step.reason})`);
        const versionId = await deps.wranglerOutput(['deploy', '--config', prepared.configPaths[role], '--message', message, ...secretArgs], 'deploy');
        deployed[role] = { version_id: versionId, mode: 'deploy' };
      } else {
        log(`uploading a version of ${step.name}`);
        const versionId = await deps.wranglerOutput(['versions', 'upload', '--config', prepared.configPaths[role], '--message', message, ...secretArgs], 'version-upload');
        await deps.wrangler(['versions', 'deploy', `${versionId}@100%`, '--name', step.name, '--message', message, '--yes']);
        // Versions carry code, bindings and secrets; routes, custom domains and crons are triggers.
        await deps.wrangler(['triggers', 'deploy', '--config', prepared.configPaths[role]]);
        deployed[role] = { version_id: versionId, mode: 'version' };
      }
    }
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
  return deployed;
}

// ─── Doctor ───────────────────────────────────────────────────────────────

async function getJson(deps, url) {
  try {
    const response = await deps.fetch(url, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* reported by the caller */ }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error.message };
  }
}

/**
 * Check both scripts once: /api/version serves the expected release and role,
 * /api/readyz is ready. Only check names and details are reported, never values.
 */
export async function doctorSelfHost({ config, expected = {}, deps }) {
  const origins = originsFor(config);
  const results = [];
  for (const role of ROLES) {
    const version = await getJson(deps, `${origins[role]}/api/version`);
    const problems = [];
    if (version.status !== 200 || !version.body) problems.push(`/api/version answered ${version.status || version.error}`);
    else {
      const want = { service_role: role, core_version: expected.core_version ?? config.coreVersion,
        ...(expected.bundle_digest ?? config.bundleSha256 ? { bundle_digest: expected.bundle_digest ?? config.bundleSha256 } : {}),
        ...(expected.source_sha ? { source_sha: expected.source_sha } : {}) };
      for (const [key, value] of Object.entries(want)) {
        if (version.body[key] !== value) problems.push(`${key} is ${JSON.stringify(version.body[key])}, expected ${JSON.stringify(value)}`);
      }
    }
    const ready = await getJson(deps, `${origins[role]}/api/readyz`);
    if (ready.status === 503 && !ready.body) problems.push('the store has no current installation record (data schema gate); see the self-hosting guide');
    else if (!ready.body) problems.push(`/api/readyz answered ${ready.status || ready.error}`);
    else if (!ready.body.ready) {
      for (const check of ready.body.checks ?? []) {
        if (check.required && check.state !== 'pass') problems.push(`${check.name}: ${check.detail}`);
      }
    }
    results.push({ role, origin: origins[role], ok: problems.length === 0, problems });
  }
  return { ok: results.every(result => result.ok), results };
}

/** Doctor until it passes or `attempts` run out (a new deployment takes a moment to serve everywhere). */
export async function waitForHealthy({ config, expected, deps, attempts = 12, delayMs = 5_000 }) {
  let report;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    report = await doctorSelfHost({ config, expected, deps });
    if (report.ok || attempt === attempts) return report;
    await deps.sleep(delayMs);
  }
  return report;
}
