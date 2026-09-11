import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILD_RUNTIME, MAX_SOURCE_BYTES, MAX_ARTIFACT_BYTES, decodeSource, encodeArtifact, sha256, assertFilePath } from './contract.mjs';

export const BWRAP_URL = 'https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.1_amd64.deb';
export const BWRAP_SHA = '1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a';

/**
 * Use an AppArmor-profiled system installation only when it is the pinned binary.
 * @param {string} extracted
 * @param {{lstat: (name: string) => Promise<{uid: number, mode: number, isSymbolicLink(): boolean, isFile(): boolean, isDirectory(): boolean}>, readFile: (name: string) => Promise<Uint8Array>}} disk
 */
export async function sandboxBinary(extracted, disk = fs) {
  const installed = '/usr/bin/bwrap';
  try {
    for (const name of ['/usr', '/usr/bin', installed]) {
      const stat = await disk.lstat(name);
      if (stat.uid !== 0 || (stat.mode & 0o6022) !== 0 || stat.isSymbolicLink()) return extracted;
      if (name === installed ? !stat.isFile() : !stat.isDirectory()) return extracted;
    }
    if (sha256(await disk.readFile(installed)) !== sha256(await disk.readFile(extracted))) return extracted;
    return installed;
  } catch { return extracted; }
}
export const RENDER_ADAPTER = `import { registerHooks } from 'node:module';
import { installAssetCache } from './assets.mjs';
await installAssetCache('/work');
registerHooks({ load(url, context, next) {
  if (url !== 'file:///work/scripts/media.mjs') return next(url, context);
  return { format: 'module', shortCircuit: true, source: ${JSON.stringify("import fs from 'node:fs/promises'; import path from 'node:path'; export async function prepareMedia(publication) { const prepared=JSON.parse(await fs.readFile('/work/.typeroll-runner/prepared.json','utf8')); if(prepared.publication_id!==publication.publication_id || !Array.isArray(prepared.media) || !Array.isArray(prepared.files))throw Error('prepared_media_identity_mismatch'); for(const file of prepared.files)if(!path.resolve(file.source).startsWith('/work/.publication-media/'))throw Error('prepared_media_path_mismatch'); publication.media=prepared.media; return prepared.files; }")} };
} });
await import('../scripts/build.mjs');
`;
export async function responseBytes(response, limit) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) throw Error('build_transfer_failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw Error('build_transfer_limit'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export async function outputFiles(root) {
  const files = Object.create(null); let size = 0;
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name; assertFilePath(name, { artifact: true });
      const target = path.join(dir, entry.name), stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw Error('unsafe_build_output');
      if (stat.isDirectory()) { await walk(target, name + '/'); continue; }
      size += stat.size;
      if (stat.size > 25 * 1024 * 1024 || size > MAX_ARTIFACT_BYTES || Object.keys(files).length >= 20000) throw Error('build_output_limit');
      files[name] = await fs.readFile(target);
    }
  }
  await walk(root); return files;
}

/** Only the trusted supervisor can authenticate to the coordinator or upload artifacts. */
export async function executeBuild(config, runnerToken, fetchImpl = fetch) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node !== BUILD_RUNTIME) throw Error('unsupported_build_runtime');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.org_id)) throw Error('invalid_build_coordinator');
  const root = `${origin.origin}/api/builds/runner/${config.org_id}`;
  const request = async (action, token, body) => {
    const response = await fetchImpl(`${root}/${action}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: config.revision, ...body }) });
    if (!response.ok) throw Error(`coordinator_${response.status}`);
    return response.json();
  };
  const job = await request('claim', runnerToken, { protocol: 1 });
  if (!job) { console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'idle' })); return; }
  if (job.identity.org_id !== config.org_id) throw Error('build_scope_mismatch');
  const abort = new AbortController(); let stage = 'source', heartbeatBusy = false;
  const attempt = { key: job.key, lease_id: job.lease_id };
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await request('heartbeat', job.token, attempt); } catch { abort.abort(); }
    finally { heartbeatBusy = false; }
  }, 20000);
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-build-')), work = path.join(temp, 'work');
  async function command(binary, args, timeout = 720000) {
    if (abort.signal.aborted) throw Error('build_lease_lost');
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: work, env: { PATH: process.env.PATH, HOME: temp }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16384); });
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
      const timer = setTimeout(kill, Math.min(timeout, Math.max(1, job.deadline - Date.now())));
      abort.signal.addEventListener('abort', kill, { once: true });
      const clear = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', kill); };
      child.once('error', () => { clear(); reject(Error('build_process_start_failed')); });
      child.once('exit', code => { clear(); const known = diagnostic.match(/\b(ERR_SYSTEM_ERROR|ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|EACCES|ENOENT|ENOMEM|ENOSPC)\b/);
        code === 0 && !abort.signal.aborted ? resolve() : reject(Error(known ? `build_${known[1].toLowerCase()}` : `build_process_exit_${code ?? 'terminated'}`)); });
    });
  }
  const storageUrl = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== `${job.storage_account_id}.r2.cloudflarestorage.com` || url.username || url.password || url.port) throw Error('invalid_build_storage');
    return url;
  };
  try {
    await fs.mkdir(work);
    const bytes = await responseBytes(await fetchImpl(storageUrl(job.source_url), { redirect: 'error', signal: AbortSignal.timeout(60000) }), MAX_SOURCE_BYTES);
    const files = decodeSource(bytes, job.identity.source_sha256);
    for (const [name, content] of Object.entries(files)) {
      if (name.startsWith('.typeroll-runner/')) throw Error('reserved_build_source');
      const target = path.join(work, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' });
    }
    stage = 'sandbox';
    const deb = await responseBytes(await fetchImpl(BWRAP_URL, { redirect: 'error', signal: AbortSignal.timeout(30000) }), 100000);
    if (sha256(deb) !== BWRAP_SHA) throw Error('sandbox_integrity_failed');
    await fs.writeFile(path.join(temp, 'sandbox.deb'), deb);
    await command('dpkg-deb', ['-x', path.join(temp, 'sandbox.deb'), path.join(temp, 'sandbox')], 30000);
    const binary = await sandboxBinary(path.join(temp, 'sandbox/usr/bin/bwrap'));
    await fs.writeFile(path.join(temp, 'passwd'), 'builder:x:1000:1000:Build user:/tmp:/bin/false\n');
    await fs.writeFile(path.join(temp, 'group'), 'builder:x:1000:\n');
    const runtime = path.dirname(path.dirname(await fs.realpath(process.execPath)));
    const base = ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--uid', '1000', '--gid', '1000', '--cap-drop', 'ALL',
      '--ro-bind', path.join(temp, 'passwd'), '/etc/passwd', '--ro-bind', path.join(temp, 'group'), '/etc/group', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind', '/etc/hosts', '/etc/hosts', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
      '--ro-bind', runtime, '/runtime', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', work, '/work', '--chdir', '/work',
      '--remount-ro', '/', '--clearenv', '--setenv', 'PATH', '/runtime/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
      '--setenv', 'ASTRO_TELEMETRY_DISABLED', '1', '--setenv', 'NODE_OPTIONS', '--max-old-space-size=768'];
    const run = (args, network = false, env = {}) => command(binary, [...base, ...(network ? ['--share-net'] : []),
      ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]), '/runtime/bin/node', ...args]);
    if (job.kind === 'qualification') {
      // The source and expected artifact are generated by the coordinator, not submitted by a browser.
      await run(['qualification.mjs']);
    } else {
      stage = 'dependencies';
      await run(['/runtime/lib/node_modules/npm/bin/npm-cli.js', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], true);
      await fs.mkdir(path.join(work, '.typeroll-runner'));
      await fs.writeFile(path.join(work, '.typeroll-runner/prepare.mjs'),
        "import fs from 'node:fs/promises'; import { prepareMedia } from '../scripts/media.mjs'; const publication=JSON.parse(await fs.readFile('/work/publication.json','utf8')); const files=await prepareMedia(publication,'/work'); await fs.writeFile('/work/.typeroll-runner/prepared.json',JSON.stringify({publication_id:publication.publication_id,media:publication.media,files}));\n", { flag: 'wx' });
      stage = 'media';
      // Only this trusted media stage receives exact publication-scoped object grants.
      await run(['.typeroll-runner/prepare.mjs'], true, job.media_access ? { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(job.media_access) } : {});
      stage = 'extension_assets';
      await fs.copyFile(new URL('./assets.mjs', import.meta.url), path.join(work, '.typeroll-runner/assets.mjs'));
      await run(['--input-type=module', '-e', "import { prepareAssets } from './.typeroll-runner/assets.mjs'; await prepareAssets('/work');"], true);
      stage = 'rendering';
      await fs.writeFile(path.join(work, '.typeroll-runner/render.mjs'), RENDER_ADAPTER, { flag: 'wx' });
      await run(['.typeroll-runner/render.mjs'], false, { TYPEROLL_BUILD_MEDIA_PREPARED: '/work/.typeroll-runner/prepared.json' });
    }
    stage = 'artifact';
    const artifact = encodeArtifact(job.identity, await outputFiles(path.join(work, 'dist')));
    const upload = await request('upload', job.token, attempt);
    const uploaded = await fetchImpl(storageUrl(upload.artifact_url), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json' }, body: artifact });
    if (!uploaded.ok) throw Error('artifact_upload_failed');
    await request('complete', job.token, { ...attempt, sha256: sha256(artifact) });
    console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'completed', job: job.identity.job_id, branch: job.identity.branch }));
  } catch (error) {
    const code = /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'build_failed';
    try { await request('fail', job.token, { ...attempt, code, stage }); } catch { /* A cancelled or superseded attempt cannot change publication state. */ }
    throw Error(`${stage}_${code}`);
  } finally { clearInterval(heartbeat); abort.abort(); await fs.rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!process.env.TYPEROLL_RUNNER_TOKEN) console.log('Typeroll setup pending. Return to Publishing and select Finish build setup.');
    else await executeBuild(JSON.parse(await fs.readFile(new URL('./engine.json', import.meta.url), 'utf8')), process.env.TYPEROLL_RUNNER_TOKEN); }
  catch (error) { console.error('TYPEROLL_BUILD_FAILED ' + (/^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : 'build_failed')); process.exitCode = 1; }
}
