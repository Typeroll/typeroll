#!/usr/bin/env node
// Self-host Typeroll CMS on Cloudflare, in your own account.
//
//   plan    verify the release bundle, derive the Worker configurations,
//           dry-run them and show what apply would change (read-only)
//   apply   create the EU R2 buckets, set secrets, upload and deploy the
//           portal and Forms Workers, then run doctor
//   doctor  check /api/version and /api/readyz of both Workers
//   backup  export the document store to a local directory and the EU bucket
//   restore import a backup directory into the installation and compare it
//
// Guide: packages/docs-site/src/content/docs/guides/self-hosting.mdx.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEPLOY_TOKEN_ENV, SelfHostError, applySelfHost, buildPlan, doctorSelfHost, inspectAccount, obtainBundle,
  originsFor, prepareBundle, readSecrets, readSelfHostConfig, waitForHealthy,
} from './lib/self-host-cloudflare.mjs';
import { TRANSFER_TOKEN, backupStore, restoreStore, storeTransferClient } from './lib/self-host-cloudflare-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(root, 'node_modules/wrangler/bin/wrangler.js');

const USAGE = `Usage:
  node scripts/self-host-cloudflare.mjs plan    [--config FILE] [--secrets FILE | --secrets-env] [--bundle-dir DIR]
  node scripts/self-host-cloudflare.mjs apply   --confirm ACCOUNT_ID [--config FILE] [--secrets FILE | --secrets-env] [--bundle-dir DIR]
  node scripts/self-host-cloudflare.mjs doctor  [--config FILE]
  node scripts/self-host-cloudflare.mjs backup  [--config FILE] [--secrets FILE | --secrets-env] [--out DIR] [--skip-upload]
  node scripts/self-host-cloudflare.mjs restore --in DIR --confirm PORTAL_HOST [--config FILE] [--secrets FILE | --secrets-env] [--run NAME] [--force] [--skip-upload]

The deploy token is read from ${DEPLOY_TOKEN_ENV}; runtime secrets come from the
secrets file (default .env.self-host, mode 0600) or, with --secrets-env, from
the environment.`;

const OPTIONS = {
  config: { type: 'string', default: 'self-host.cloudflare.json' },
  secrets: { type: 'string' },
  'secrets-env': { type: 'boolean', default: false },
  'bundle-dir': { type: 'string' },
  'work-dir': { type: 'string', default: path.join('temp', 'self-host-cloudflare') },
  confirm: { type: 'string' },
  out: { type: 'string' },
  in: { type: 'string' },
  run: { type: 'string' },
  force: { type: 'boolean', default: false },
  'skip-upload': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

class UsageError extends Error {}

function requireExactConfirmation(actual, supplied, label) {
  if (!supplied || supplied !== actual) throw new UsageError(`${label} confirmation must exactly equal ${actual}`);
}

/** Real side effects. Tests pass their own. */
export function systemDeps({ accountId, deployToken, workDir }) {
  const run = async (command, args, options = {}) => execFileSync(command, args, {
    cwd: root, encoding: 'utf8', input: options.input, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...options.env },
  });
  const wranglerEnv = () => {
    if (!deployToken) throw new UsageError(`${DEPLOY_TOKEN_ENV} must hold a Cloudflare API token for account ${accountId}`);
    return { CLOUDFLARE_API_TOKEN: deployToken, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' };
  };
  const wrangler = (args, options = {}) => run(process.execPath, [WRANGLER, ...args], { ...options, env: { ...wranglerEnv(), ...options.env } });
  return {
    run,
    wrangler,
    /** Run wrangler and return the version id from its structured output file. */
    async wranglerOutput(args, type) {
      const file = path.join(workDir, `wrangler-output-${process.pid}-${Date.now()}.ndjson`);
      try {
        await wrangler(args, { env: { WRANGLER_OUTPUT_FILE_PATH: file } });
        const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const entry = entries.reverse().find(item => item.type === type && item.version_id);
        if (!entry) throw new SelfHostError(`wrangler reported no ${type} version`);
        return entry.version_id;
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    async api(apiPath, headers = {}) {
      if (!deployToken) throw new UsageError(`${DEPLOY_TOKEN_ENV} must hold a Cloudflare API token for account ${accountId}`);
      const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
        headers: { Authorization: `Bearer ${deployToken}`, ...headers }, signal: AbortSignal.timeout(30_000),
      });
      let body = null;
      try { body = await response.json(); } catch { /* reported by the caller */ }
      return { status: response.status, body };
    },
    fetch: (url, init) => fetch(url, init),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

function loadSecrets(values, env) {
  if (values['secrets-env']) return readSecrets({ env });
  const file = values.secrets ?? (fs.existsSync('.env.self-host') ? '.env.self-host' : null);
  if (!file) throw new UsageError('Pass --secrets FILE (mode 0600) or --secrets-env');
  return readSecrets({ file });
}

async function prepare(config, values, deps) {
  const workDir = path.resolve(values['work-dir']);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const bundle = await obtainBundle({ config, bundleDir: values['bundle-dir'], workDir, deps });
  const prepared = prepareBundle({ bundle, config, workDir });
  // Proves both configurations build from the bundle without contacting Cloudflare.
  for (const [role, configPath] of Object.entries(prepared.configPaths)) {
    await deps.wrangler(['deploy', '--dry-run', '--config', configPath, '--outdir', path.join(workDir, 'dry-run', role)]);
  }
  return { workDir, bundle, prepared };
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, log = message => process.stderr.write(`${message}\n`), out = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  deps: injected, loadMigrationLibrary,
} = {}) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); }
  catch (error) { log(`${error.message}\n${USAGE}`); return 2; }
  const [command] = parsed.positionals;
  const values = parsed.values;
  if (values.help || !command) { log(USAGE); return values.help ? 0 : 2; }
  if (!['plan', 'apply', 'doctor', 'backup', 'restore'].includes(command)) { log(`Unknown command: ${command}\n${USAGE}`); return 2; }
  try {
    const config = readSelfHostConfig(values.config);
    const deps = injected ?? systemDeps({ accountId: config.accountId, deployToken: env[DEPLOY_TOKEN_ENV]?.trim(), workDir: path.resolve(values['work-dir']) });

    if (command === 'doctor') {
      const report = await doctorSelfHost({ config, deps });
      out(report);
      return report.ok ? 0 : 1;
    }

    if (command === 'plan' || command === 'apply') {
      if (command === 'apply') requireExactConfirmation(config.accountId, values.confirm, 'Cloudflare account');
      const secrets = loadSecrets(values, env);
      const { workDir, bundle, prepared } = await prepare(config, values, deps);
      const account = await inspectAccount({ config, deps });
      const plan = buildPlan({ config, bundle, account, secrets, origins: prepared.origins });
      if (command === 'plan') { out(plan); return plan.problems.length ? 1 : 0; }
      log(JSON.stringify(plan, null, 2));
      const deployed = await applySelfHost({ config, bundle, prepared, plan, secrets, workDir, deps, log });
      const health = await waitForHealthy({ config, deps, expected: { core_version: bundle.release.core_version, bundle_digest: bundle.digest, source_sha: bundle.release.source_sha } });
      out({ deployed, health });
      return health.ok ? 0 : 1;
    }

    const origins = originsFor(config);
    const secrets = loadSecrets(values, env);
    const token = secrets[TRANSFER_TOKEN];
    const client = storeTransferClient({ origin: origins.portal, token, fetch: deps.fetch });
    const lib = await (loadMigrationLibrary ?? (await import('./lib/migration-library.mjs')).loadMigrationLibrary)();
    const upload = !values['skip-upload'];

    if (command === 'backup') {
      const version = await (await deps.fetch(`${origins.portal}/api/version`, { redirect: 'error' })).json();
      const run = `backup-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      const dir = path.resolve(values.out ?? path.join('backups', run));
      const descriptor = await backupStore({ lib, client, origin: origins.portal, dir, bucket: config.buckets.backups, run, coreVersion: version.core_version, deps, upload, log });
      out({ dir, ...descriptor });
      return 0;
    }

    if (!values.in) throw new UsageError('restore needs --in DIR');
    requireExactConfirmation(new URL(origins.portal).host, values.confirm, 'Restore target host');
    const result = await restoreStore({ lib, client, dir: path.resolve(values.in), bucket: config.buckets.backups, deps, run: values.run, force: values.force, upload, log });
    out(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) { log(`${error.message}\n${USAGE}`); return 2; }
    if (error instanceof SelfHostError) { log(error.message); return 1; }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
