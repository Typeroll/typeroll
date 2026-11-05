import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assetNames, buildBundle } from './release-worker-bundle.mjs';
import {
  SelfHostError, applySelfHost, buildPlan, deriveSelfHostConfigs, doctorSelfHost, inspectAccount, obtainBundle,
  prepareBundle, readSecrets, uploadMode, validateSelfHostConfig,
} from './lib/self-host-cloudflare.mjs';
import { main } from './self-host-cloudflare.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SHA = 'a'.repeat(40);
const identity = { source_sha: SHA, lock_sha256: 'b'.repeat(64), node_version: '22.23.1', wrangler_version: '4.158.0', build_root: '/build' };
const facts = { core_version: '0.3.0', data_schema_version: 2, data_schema_readable: { min: 2, max: 2 } };
// What `astro build` generates from packages/portal/wrangler.jsonc.
const generated = {
  name: 'typeroll-portal',
  main: 'entry.mjs',
  no_bundle: true,
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'ESModule', globs: ['**/*.mjs'] }],
  assets: { binding: 'ASSETS', directory: '../client' },
  durable_objects: { bindings: [{ name: 'STORE', class_name: 'DocumentStore' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['DocumentStore'] }],
  r2_buckets: [{ binding: 'MIGRATION', bucket_name: 'typeroll-migration', jurisdiction: 'eu' }],
  triggers: { crons: ['*/5 * * * *'] },
  services: [{ binding: 'SCHEDULER', service: 'typeroll-portal', entrypoint: 'Scheduler' }],
  vars: { TYPEROLL_RUNTIME: 'workers', STORE_JURISDICTION: 'eu', TYPEROLL_SCHEDULER: 'durable_object' },
  observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } },
  configPath: '/build/packages/portal/wrangler.jsonc',
  dev: { port: 4321 },
};
const rawConfig = {
  account_id: ACCOUNT,
  core_version: '0.3.0',
  portal_host: 'cms.example.org',
  forms_host: 'forms.example.org',
  media_public_url: 'https://media.example.org',
  sites_base_domain: 'sites.example.org',
};
const SECRET_VALUES = {
  ACCOUNT_EMAIL: '{"type":"smtp","from":"cms@example.org","config":{}}',
  AUTH_SECRET: 's'.repeat(40),
  EXTENSION_SIGNING_PRIVATE_JWK: '{"kty":"OKP"}',
  FORMS_HMAC_SECRET: 'forms-secret-value',
  INTEGRATIONS_SECRET_KEY: 'integrations-secret-value',
  MCP_OAUTH_SIGNING_KEY: 'mcp-secret-value',
  PREVIEW_HMAC_SECRET: 'preview-secret-value',
  R2_ACCESS_KEY_ID: 'r2-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-secret-value',
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-host-cf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A released bundle in `dir`, as `gh release download` leaves it. */
function releasedBundle(t, dir, config = generated) {
  const dist = tempDir(t);
  const write = (relative, body) => {
    fs.mkdirSync(path.dirname(path.join(dist, relative)), { recursive: true });
    fs.writeFileSync(path.join(dist, relative), body);
  };
  write('server/wrangler.json', JSON.stringify(config));
  write('server/entry.mjs', 'class DocumentStore {}\nexport { DocumentStore, Scheduler, OperatorApi, worker_entry_default as default };\n');
  write('client/_astro/app.js', 'console.log(1)');
  const { tarball, descriptor } = buildBundle({ distDirectory: dist, identity, facts });
  const names = assetNames('0.3.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, names.tarball), tarball);
  fs.writeFileSync(path.join(dir, names.descriptor), JSON.stringify(descriptor));
  return descriptor;
}

/** A Cloudflare account and the CLIs, recorded instead of called. */
function fakeDeps({ scripts = {}, buckets = {}, attested = true, versionHealthy = true } = {}) {
  const calls = [];
  const deps = {
    calls,
    async run(command, args) {
      calls.push([command, ...args]);
      if (command === 'gh' && args[0] === 'attestation' && !attested) throw new Error('no attestation found');
      return '';
    },
    async wrangler(args) {
      calls.push(['wrangler', ...args]);
      if (args[0] === 'secret' && args[1] === 'list') return JSON.stringify((scripts[args[3]]?.secrets ?? []).map(name => ({ name, type: 'secret_text' })));
      return '';
    },
    async wranglerOutput(args, type) {
      calls.push(['wrangler', ...args]);
      const secretsFile = args[args.indexOf('--secrets-file') + 1];
      if (args.includes('--secrets-file')) calls.push(['secrets-file', Object.keys(JSON.parse(fs.readFileSync(secretsFile, 'utf8'))).sort().join(',')]);
      return `${type}-0000-0000-0000-000000000000`.slice(0, 36);
    },
    async api(apiPath) {
      const bucket = apiPath.match(/\/r2\/buckets\/(.+)$/)?.[1];
      if (bucket) return buckets[bucket] ? { status: 200, body: { success: true, result: { name: bucket, jurisdiction: buckets[bucket] } } } : { status: 404, body: { success: false } };
      const script = apiPath.match(/\/workers\/services\/(.+)$/)?.[1];
      if (scripts[script]) return { status: 200, body: { success: true, result: { default_environment: { script: { migration_tag: scripts[script].migration_tag ?? null } } } } };
      return { status: 404, body: { success: false } };
    },
    async fetch(url) {
      const { host, pathname } = new URL(url);
      const role = host.startsWith('forms') ? 'forms' : 'portal';
      const body = pathname === '/api/version'
        ? { service_role: role, core_version: '0.3.0', source_sha: SHA, bundle_digest: deps.digest }
        : versionHealthy ? { ready: true, checks: [] } : { ready: false, checks: [{ name: 'identity', state: 'fail', required: true, detail: 'missing AUTH_SECRET' }] };
      return new Response(JSON.stringify(body), { status: pathname === '/api/readyz' && !versionHealthy ? 503 : 200 });
    },
    sleep: async () => {},
  };
  return deps;
}

test('validates the configuration and derives names, origins and buckets', () => {
  const config = validateSelfHostConfig(rawConfig);
  assert.deepEqual(config.scripts, { portal: 'typeroll-portal', forms: 'typeroll-forms' });
  assert.deepEqual(config.buckets, { media: 'typeroll-media', private_drafts: 'typeroll-private-drafts', backups: 'typeroll-backups' });
  assert.equal(validateSelfHostConfig({ ...rawConfig, core_version: undefined }, { defaultCoreVersion: '9.9.9' }).coreVersion, '9.9.9');
  const invalid = (patch, pattern) => assert.throws(() => validateSelfHostConfig({ ...rawConfig, ...patch }), pattern);
  invalid({ account_id: 'nope' }, /account_id/);
  invalid({ forms_host: undefined }, /both portal_host and forms_host/);
  invalid({ forms_host: 'cms.example.org' }, /own hostname/);
  invalid({ portal_host: undefined, forms_host: undefined }, /workers_subdomain/);
  invalid({ media_public_url: 'http://media.example.org' }, /media_public_url/);
  invalid({ vars: { AUTH_SECRET: 'x' } }, /is a secret/);
  invalid({ vars: { STORE_JURISDICTION: 'none' } }, /set by the profile/);
  invalid({ buckets: { media: 'same', backups: 'same' } }, /three different buckets/);
  invalid({ region: 'us' }, /unknown setting region/);
});

test('reads secrets by name from an owner-only file or the environment', t => {
  const dir = tempDir(t);
  const file = path.join(dir, '.env.self-host');
  fs.writeFileSync(file, 'AUTH_SECRET=from-file\nUNRELATED=ignored\nCLOUDFLARE_API_TOKEN=runtime-token\n', { mode: 0o644 });
  assert.throws(() => readSecrets({ file, platform: 'linux' }), /chmod 600/);
  fs.chmodSync(file, 0o600);
  assert.deepEqual(readSecrets({ file, platform: 'linux' }), { AUTH_SECRET: 'from-file', CLOUDFLARE_API_TOKEN: 'runtime-token' });
  assert.deepEqual(readSecrets({ env: { FORMS_HMAC_SECRET: ' x ', PATH: '/bin' } }), { FORMS_HMAC_SECRET: 'x' });
});

test('derives EU-only portal and Forms configurations from the generated one', () => {
  const config = validateSelfHostConfig({ ...rawConfig, logpush: true, vars: { TYPEROLL_PUBLISH_GITHUB_APP_SLUG: 'my-app' } });
  const release = { source_sha: SHA, workers: { portal: { main: 'entry.mjs', migrations: generated.migrations, migration_tag: 'v1', crons: ['*/5 * * * *'], bindings: { r2_buckets: ['MIGRATION'] }, secrets_required: [] } } };
  const { configs, origins } = deriveSelfHostConfigs({ config, generated, release, digest: `sha256:${'d'.repeat(64)}` });
  const { portal, forms } = configs;
  assert.deepEqual(origins, { portal: 'https://cms.example.org', forms: 'https://forms.example.org' });
  for (const derived of [portal, forms]) {
    assert.equal(derived.account_id, ACCOUNT);
    assert.equal(derived.preview_urls, false);
    assert.equal(derived.workers_dev, false);
    assert.equal(derived.logpush, true);
    assert.deepEqual(derived.observability, { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } });
    assert.equal(derived.vars.STORE_JURISDICTION, 'eu');
    assert.equal(derived.vars.TYPEROLL_BUNDLE_DIGEST, `sha256:${'d'.repeat(64)}`);
    assert.equal(derived.vars.TYPEROLL_PUBLISH_GITHUB_APP_SLUG, 'my-app');
    assert.equal(derived.vars.TYPEROLL_STORE_BOOTSTRAP, 'empty');
    assert.ok(!('configPath' in derived) && !('dev' in derived) && !('placement' in derived));
    assert.deepEqual(derived.services, [{ binding: 'SCHEDULER', service: 'typeroll-portal', entrypoint: 'Scheduler' }]);
  }
  assert.equal(portal.name, 'typeroll-portal');
  assert.deepEqual(portal.routes, [{ pattern: 'cms.example.org', custom_domain: true }]);
  assert.deepEqual(portal.r2_buckets, [{ binding: 'MIGRATION', bucket_name: 'typeroll-backups', jurisdiction: 'eu' }]);
  assert.deepEqual(portal.triggers, { crons: ['*/5 * * * *'] });
  assert.deepEqual(portal.migrations, generated.migrations);
  assert.equal(portal.vars.R2_BUCKET, 'typeroll-media');
  assert.equal(portal.vars.R2_PRIVATE_BUCKET, 'typeroll-private-drafts');
  assert.equal(portal.vars.SITES_BASE_DOMAIN, 'sites.example.org');
  assert.equal(forms.name, 'typeroll-forms');
  assert.equal(forms.vars.SERVICE_ROLE, 'forms');
  assert.equal(forms.migrations, undefined);
  assert.deepEqual(forms.triggers, { crons: [] });
  assert.deepEqual(forms.r2_buckets, []);
  assert.deepEqual(forms.durable_objects.bindings, [{ name: 'STORE', class_name: 'DocumentStore', script_name: 'typeroll-portal' }]);
  assert.equal(forms.assets.run_worker_first, true);
  for (const name of Object.keys(SECRET_VALUES)) assert.ok(!(name in portal.vars) && !(name in forms.vars));
});

test('refuses bundles that bind services or buckets the profile does not provide', () => {
  const config = validateSelfHostConfig(rawConfig);
  const release = { source_sha: SHA, workers: { portal: { main: 'entry.mjs', migrations: generated.migrations, migration_tag: 'v1', crons: [], bindings: { r2_buckets: [] } } } };
  assert.throws(() => deriveSelfHostConfigs({ config, generated: { ...generated, services: [{ binding: 'X', service: 'elsewhere' }] }, release, digest: 'sha256:x' }), /does not provide/);
  assert.throws(() => deriveSelfHostConfigs({ config, generated, release: { ...release, workers: { portal: { ...release.workers.portal, bindings: { r2_buckets: ['MEDIA'] } } } }, digest: 'sha256:x' }), /R2 binding MEDIA/);
  assert.throws(() => deriveSelfHostConfigs({ config, generated: { ...generated, main: 'other.mjs' }, release, digest: 'sha256:x' }), /does not match/);
});

test('downloads, verifies the digest and provenance, and refuses an unattested bundle', async t => {
  const dir = tempDir(t);
  const config = validateSelfHostConfig(rawConfig);
  const bundleDir = path.join(dir, 'given');
  const descriptor = releasedBundle(t, bundleDir);
  const deps = fakeDeps();
  const bundle = await obtainBundle({ config, bundleDir, workDir: dir, deps });
  assert.equal(bundle.digest, descriptor.sha256);
  const attestation = deps.calls.find(call => call[1] === 'attestation');
  assert.deepEqual(attestation.slice(4), ['--repo', 'Typeroll/typeroll', '--signer-workflow', 'Typeroll/typeroll/.github/workflows/publish-mcp.yml',
    '--source-ref', 'refs/heads/main', '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners']);
  await assert.rejects(obtainBundle({ config, bundleDir, workDir: dir, deps: fakeDeps({ attested: false }) }), /no valid GitHub build provenance/);
  await assert.rejects(obtainBundle({ config: { ...config, bundleSha256: `sha256:${'0'.repeat(64)}` }, bundleDir, workDir: dir, deps }), /not the pinned/);
  // Without a local copy the bundle comes from the Core release.
  const download = fakeDeps();
  await assert.rejects(obtainBundle({ config, bundleDir: path.join(dir, 'absent'), workDir: path.join(dir, 'work'), deps: download }), /has no Worker bundle/);
  assert.deepEqual(download.calls[0].slice(0, 5), ['gh', 'release', 'download', 'core-v0.3.0', '--repo']);
});

test('chooses atomic deploys for first deployments and migrations, versions otherwise', () => {
  const contract = { migration_tag: 'v2', migrations: [{ tag: 'v1' }, { tag: 'v2' }] };
  assert.equal(uploadMode('portal', { exists: false }, contract).mode, 'deploy');
  assert.equal(uploadMode('portal', { exists: true, migration_tag: 'v1' }, contract).mode, 'deploy');
  assert.equal(uploadMode('portal', { exists: true, migration_tag: 'v2' }, contract).mode, 'version');
  assert.equal(uploadMode('forms', { exists: true, migration_tag: null }, contract).mode, 'version');
  assert.throws(() => uploadMode('portal', { name: 'p', exists: true, migration_tag: 'v3' }, contract), /does not know/);
});

test('plans and applies a first installation without printing a secret', async t => {
  const dir = tempDir(t);
  const config = validateSelfHostConfig(rawConfig);
  releasedBundle(t, path.join(dir, 'bundle'));
  const deps = fakeDeps({ buckets: { 'typeroll-media': 'eu' } });
  const bundle = await obtainBundle({ config, bundleDir: path.join(dir, 'bundle'), workDir: dir, deps });
  deps.digest = bundle.digest;
  const prepared = prepareBundle({ bundle, config, workDir: dir });
  const written = JSON.parse(fs.readFileSync(prepared.configPaths.portal, 'utf8'));
  assert.equal(path.dirname(prepared.configPaths.portal), path.join(dir, 'extracted/portal/server'));
  assert.equal(written.main, 'entry.mjs');

  const incomplete = buildPlan({ config, bundle, account: await inspectAccount({ config, deps }), secrets: { AUTH_SECRET: 'x' }, origins: prepared.origins });
  assert.match(incomplete.problems[0], /typeroll-portal is missing required secrets: ACCOUNT_EMAIL/);
  await assert.rejects(applySelfHost({ config, bundle, prepared, plan: incomplete, secrets: {}, workDir: dir, deps }), /stopped before any change/);
  assert.equal(deps.calls.filter(call => call[0] === 'wrangler' && call[1] !== 'secret').length, 0);

  const plan = buildPlan({ config, bundle, account: await inspectAccount({ config, deps }), secrets: SECRET_VALUES, origins: prepared.origins });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.buckets, {
    media: { name: 'typeroll-media', action: 'present' },
    private_drafts: { name: 'typeroll-private-drafts', action: 'create (eu)' },
    backups: { name: 'typeroll-backups', action: 'create (eu)' },
  });
  assert.equal(plan.scripts.portal.mode, 'deploy');
  for (const value of Object.values(SECRET_VALUES)) assert.ok(!JSON.stringify(plan).includes(value));

  const logs = [];
  const deployed = await applySelfHost({ config, bundle, prepared, plan, secrets: SECRET_VALUES, workDir: dir, deps, log: message => logs.push(message) });
  assert.deepEqual(Object.keys(deployed), ['portal', 'forms']);
  const commands = deps.calls.filter(call => call[0] === 'wrangler' || call[0] === 'secrets-file').map(call => call.slice(0, call[1] === 'r2' ? 5 : 4).join(' '));
  assert.deepEqual(commands.filter(command => !command.startsWith('wrangler secret list')), [
    'wrangler r2 bucket create typeroll-private-drafts',
    'wrangler r2 bucket create typeroll-backups',
    `wrangler deploy --config ${prepared.configPaths.portal}`,
    'secrets-file ACCOUNT_EMAIL,AUTH_SECRET,EXTENSION_SIGNING_PRIVATE_JWK,FORMS_HMAC_SECRET,INTEGRATIONS_SECRET_KEY,MCP_OAUTH_SIGNING_KEY,PREVIEW_HMAC_SECRET,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY',
    `wrangler deploy --config ${prepared.configPaths.forms}`,
    'secrets-file AUTH_SECRET,EXTENSION_SIGNING_PRIVATE_JWK,FORMS_HMAC_SECRET,INTEGRATIONS_SECRET_KEY',
  ]);
  assert.ok(deps.calls.filter(call => call[1] === 'r2').every(call => call.at(-1) === 'eu'));
  assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('secrets-')), 'the temporary secrets files are removed');
  for (const value of Object.values(SECRET_VALUES)) assert.ok(!logs.join('\n').includes(value) && !JSON.stringify(deps.calls).includes(value));

  const health = await doctorSelfHost({ config, expected: { core_version: '0.3.0', bundle_digest: bundle.digest, source_sha: SHA }, deps });
  assert.equal(health.ok, true);
});

test('updates an installation as versions when the Durable Object schema is unchanged', async t => {
  const dir = tempDir(t);
  const config = validateSelfHostConfig(rawConfig);
  releasedBundle(t, path.join(dir, 'bundle'));
  const allBuckets = { 'typeroll-media': 'eu', 'typeroll-private-drafts': 'eu', 'typeroll-backups': 'eu' };
  const existing = { secrets: Object.keys(SECRET_VALUES), migration_tag: 'v1' };
  const deps = fakeDeps({ buckets: allBuckets, scripts: { 'typeroll-portal': existing, 'typeroll-forms': { ...existing, migration_tag: null } } });
  const bundle = await obtainBundle({ config, bundleDir: path.join(dir, 'bundle'), workDir: dir, deps });
  const prepared = prepareBundle({ bundle, config, workDir: dir });
  // Secrets already on the scripts satisfy the plan without being supplied again.
  const plan = buildPlan({ config, bundle, account: await inspectAccount({ config, deps }), secrets: {}, origins: prepared.origins });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.scripts.portal.mode, 'version');
  await applySelfHost({ config, bundle, prepared, plan, secrets: {}, workDir: dir, deps });
  const commands = deps.calls.filter(call => call[0] === 'wrangler' && call[1] !== 'secret').map(call => call.slice(1, 3).join(' '));
  assert.deepEqual(commands, ['versions upload', 'versions deploy', 'triggers deploy', 'versions upload', 'versions deploy', 'triggers deploy']);
  const deploy = deps.calls.find(call => call[1] === 'versions' && call[2] === 'deploy');
  assert.match(deploy[3], /^version-upload-.*@100%$/);
  assert.ok(!deps.calls.some(call => call.includes('--secrets-file')), 'no secrets file when none is supplied');
});

test('refuses a bucket name that exists outside the EU jurisdiction', async t => {
  const dir = tempDir(t);
  const config = validateSelfHostConfig(rawConfig);
  releasedBundle(t, path.join(dir, 'bundle'));
  const deps = fakeDeps({ buckets: { 'typeroll-media': 'fedramp' } });
  const bundle = await obtainBundle({ config, bundleDir: path.join(dir, 'bundle'), workDir: dir, deps });
  const prepared = prepareBundle({ bundle, config, workDir: dir });
  const plan = buildPlan({ config, bundle, account: await inspectAccount({ config, deps }), secrets: SECRET_VALUES, origins: prepared.origins });
  assert.match(plan.problems.join('\n'), /typeroll-media exists outside the EU/);
});

test('doctor reports a wrong release and failing readiness checks by name only', async () => {
  const config = validateSelfHostConfig({ ...rawConfig, core_version: '0.3.1' });
  const report = await doctorSelfHost({ config, deps: fakeDeps({ versionHealthy: false }) });
  assert.equal(report.ok, false);
  assert.deepEqual(report.results[0].problems, ['core_version is "0.3.0", expected "0.3.1"', 'identity: missing AUTH_SECRET']);
  const gated = await doctorSelfHost({ config: validateSelfHostConfig(rawConfig), deps: { ...fakeDeps(), fetch: async url => url.endsWith('/api/readyz')
    ? new Response('Typeroll is being upgraded.', { status: 503 })
    : new Response(JSON.stringify({ service_role: url.includes('forms') ? 'forms' : 'portal', core_version: '0.3.0' })) } });
  assert.match(gated.results[0].problems[0], /installation record/);
});

test('the CLI requires the exact account confirmation before apply', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'self-host.cloudflare.json');
  fs.writeFileSync(file, JSON.stringify(rawConfig));
  const logs = [];
  const code = await main(['apply', '--config', file, '--confirm', 'f'.repeat(32)], { deps: fakeDeps(), log: message => logs.push(message), out: () => {} });
  assert.equal(code, 2);
  assert.match(logs.join('\n'), new RegExp(`must exactly equal ${ACCOUNT}`));
  assert.equal(await main(['nonsense', '--config', file], { deps: fakeDeps(), log: () => {}, out: () => {} }), 2);
});

test('the CLI plans from a local bundle with secrets from the environment', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'self-host.cloudflare.json');
  fs.writeFileSync(file, JSON.stringify(rawConfig));
  releasedBundle(t, path.join(dir, 'bundle'));
  const outputs = [];
  const deps = fakeDeps();
  const code = await main(['plan', '--config', file, '--secrets-env', '--bundle-dir', path.join(dir, 'bundle'), '--work-dir', path.join(dir, 'work')],
    { env: SECRET_VALUES, deps, log: () => {}, out: value => outputs.push(value) });
  assert.equal(code, 0, JSON.stringify(outputs));
  assert.equal(outputs[0].scripts.portal.mode, 'deploy');
  assert.equal(deps.calls.filter(call => call[1] === 'deploy' && call[2] === '--dry-run').length, 2);
  assert.ok(!deps.calls.some(call => call[1] === 'r2' || (call[1] === 'deploy' && call[2] !== '--dry-run')), 'plan changes nothing');
  assert.throws(() => { throw new SelfHostError('x'); }, SelfHostError);
});
