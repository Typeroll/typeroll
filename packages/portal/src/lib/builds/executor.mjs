import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeStaticOutput, validateDirectReceipt, DIRECT_RECEIPT } from './direct-upload.mjs';
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
  const job = await request('claim', runnerToken, { protocol: 1, media_batch_access: true });
  if (!job) { console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'idle' })); return; }
  if (job.identity.org_id !== config.org_id) throw Error('build_scope_mismatch');
  const startedAt = Date.now();
  const abort = new AbortController(); let stage = 'source', heartbeatBusy = false;
  const attempt = { key: job.key, lease_id: job.lease_id };
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await request('heartbeat', job.token, attempt); } catch { abort.abort(); }
    finally { heartbeatBusy = false; }
  }, 20000);
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-build-')), work = path.join(temp, 'work');
  async function command(binary, args, timeout = 720000, environment = {}, cwd = work) {
    if (abort.signal.aborted) throw Error('build_lease_lost');
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env: { PATH: process.env.PATH, HOME: temp, ...environment }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      let diagnostic = '', timedOut = false;
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16384); });
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(timeout, Math.max(1, job.deadline - Date.now())));
      abort.signal.addEventListener('abort', kill, { once: true });
      const clear = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', kill); };
      child.once('error', () => { clear(); reject(Error('build_process_start_failed')); });
      child.once('exit', code => { clear(); const known = diagnostic.match(/\b(ERR_SYSTEM_ERROR|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|EACCES|ENOENT|ENOMEM|ENOSPC|media_transfer_interrupted)\b/);
        code === 0 && !abort.signal.aborted ? resolve() : reject(Error(timedOut ? 'build_process_timeout' : known ? (known[1] === 'media_transfer_interrupted' ? known[1] : `build_${known[1].toLowerCase()}`) : `build_process_exit_${code ?? 'terminated'}`)); });
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
      stage = 'uploader';
      await command(process.execPath, [fileURLToPath(new URL('./node_modules/wrangler/bin/wrangler.js', import.meta.url)), '--version'], 30000,
        { CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(temp, 'qualification.log') }, temp);
      // The source and expected artifact are generated by the coordinator, not submitted by a browser.
      await run(['qualification.mjs']);
    } else {
      stage = 'dependencies';
      await run(['/runtime/lib/node_modules/npm/bin/npm-cli.js', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], true);
      await fs.mkdir(path.join(work, '.typeroll-runner'));
      await fs.writeFile(path.join(work, '.typeroll-runner/prepare.mjs'),
        "import fs from 'node:fs/promises'; import { prepareMedia } from '../scripts/media.mjs'; const publication=JSON.parse(await fs.readFile('/work/publication.json','utf8')); const files=await prepareMedia(publication,'/work'); await fs.writeFile('/work/.typeroll-runner/prepared.json',JSON.stringify({publication_id:publication.publication_id,media:publication.media,files}));\n", { flag: 'wx' });
      stage = 'media';
      let mediaCursor = job.media_cursor ?? 0;
      while (job.media_total > mediaCursor) {
        await fs.writeFile(path.join(work, '.typeroll-runner/media-batch.mjs'),
          "import fs from 'node:fs/promises'; import { prepareMediaBatch } from '../scripts/media.mjs'; const publication=JSON.parse(await fs.readFile('/work/publication.json','utf8')); const progress=await prepareMediaBatch(publication,'/work'," + JSON.stringify(mediaCursor) + ", { cacheOnly: " + JSON.stringify(job.kind === 'media_preparation') + " }); await fs.writeFile('/work/.typeroll-runner/media-progress.json',JSON.stringify(progress));\n");
        const access = job.media_access_batched ? await request('media-access', job.token, { ...attempt, cursor: mediaCursor }) : job.media_access;
        await run(['.typeroll-runner/media-batch.mjs'], true, access ? { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(access) } : {});
        const progress = JSON.parse(await fs.readFile(path.join(work, '.typeroll-runner/media-progress.json'), 'utf8'));
        if (progress.total !== job.media_total) throw Error('media_preparation_scope_mismatch');
        const continueBuild = progress.cursor === progress.total;
        // Leave two minutes for shutdown and coordinator retries. Every batch
        // is durable even when the provider kills this process between batches.
        const keepLease = continueBuild || Date.now() < Math.min(startedAt + 12 * 60_000, job.deadline - 120_000);
        await request('media-checkpoint', job.token, { ...attempt, cursor: progress.cursor, continue_build: continueBuild, keep_lease: keepLease });
        mediaCursor = progress.cursor;
        if (!keepLease) {
          console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'preparing_media', completed: progress.cursor, total: progress.total, job: job.identity.job_id, branch: job.identity.branch }));
          return;
        }
      }
      if (job.kind === 'media_preparation') {
        await fs.mkdir(path.join(work, 'dist/.well-known/typeroll'), { recursive: true });
        await fs.writeFile(path.join(work, 'dist/.well-known/typeroll/publication.json'), JSON.stringify({ id: job.identity.publication_id }));
        await fs.writeFile(path.join(work, 'dist/preparation.json'), JSON.stringify({ publication_id: job.identity.publication_id, completed: job.media_total }));
      } else {
      // Only this trusted media stage receives exact publication-scoped object grants.
      if (job.media_access_batched && job.media_total) {
        const prepared = { publication_id: job.identity.publication_id, media: [], files: [] };
        let cursor = 0;
        while (cursor < job.media_total) {
          const access = await request('media-access', job.token, { ...attempt, cursor });
          await fs.writeFile(path.join(work, '.typeroll-runner/materialize.mjs'),
            "import fs from 'node:fs/promises'; import { prepareMediaBatch } from '../scripts/media.mjs'; const publication=JSON.parse(await fs.readFile('/work/publication.json','utf8')); const result=await prepareMediaBatch(publication,'/work'," + cursor + ",{materialize:true}); await fs.writeFile('/work/.typeroll-runner/materialized.json',JSON.stringify(result));");
          await run(['.typeroll-runner/materialize.mjs'], true, { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(access) });
          const result = JSON.parse(await fs.readFile(path.join(work, '.typeroll-runner/materialized.json'), 'utf8'));
          if (result.cursor <= cursor || result.cursor > Math.min(cursor + 100, job.media_total) || result.total !== job.media_total || !Array.isArray(result.files) || !Array.isArray(result.media)) throw Error('media_materialization_scope_mismatch');
          prepared.files.push(...result.files); prepared.media.push(...result.media); cursor = result.cursor;
        }
        const byId = new Map(prepared.media.map(media => [media.id, media]));
        const publication = JSON.parse(files['publication.json']);
        if (publication.media_manifest.entries.some(entry => !byId.has(entry.id))) throw Error('media_materialization_incomplete');
        prepared.media = publication.media.map(media => byId.get(media.id) ?? media);
        await fs.writeFile(path.join(work, '.typeroll-runner/prepared.json'), JSON.stringify(prepared));
      } else await run(['.typeroll-runner/prepare.mjs'], true, job.media_access ? { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(job.media_access) } : {});
      stage = 'extension_assets';
      await fs.copyFile(new URL('./assets.mjs', import.meta.url), path.join(work, '.typeroll-runner/assets.mjs'));
      await run(['--input-type=module', '-e', "import { prepareAssets } from './.typeroll-runner/assets.mjs'; await prepareAssets('/work');"], true);
      stage = 'rendering';
      await fs.writeFile(path.join(work, '.typeroll-runner/render.mjs'), RENDER_ADAPTER, { flag: 'wx' });
      await run(['.typeroll-runner/render.mjs'], false, { TYPEROLL_BUILD_MEDIA_PREPARED: '/work/.typeroll-runner/prepared.json' });
    }
    }
    stage = 'artifact';
    let artifactFiles;
    if (job.kind === 'publication' && job.direct_upload) {
      const dist = path.join(work, 'dist');
      const description = await describeStaticOutput(dist);
      const grant = await request('direct-upload', job.token, attempt);
      if (typeof grant.jwt !== 'string' || grant.jwt.length > 16384) throw Error('invalid_pages_upload_grant');
      const manifestPath = path.join(temp, 'pages-manifest.json');
      const logPath = path.join(temp, 'wrangler.log'); await fs.symlink('/dev/null', logPath);
      // The official uploader runs outside the untrusted source sandbox. It has
      // an asset-only JWT, never the organization's Cloudflare API credential.
      // Wrangler also requires its generic token variable at the authentication gate.
      await command(process.execPath, [fileURLToPath(new URL('./node_modules/wrangler/bin/wrangler.js', import.meta.url)),
        'pages', 'project', 'upload', dist, '--output-manifest-path', manifestPath], 300000,
        { CF_PAGES_UPLOAD_JWT: grant.jwt, CLOUDFLARE_API_TOKEN: grant.jwt, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: logPath }, temp);
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const receipt = validateDirectReceipt({ format: 1, ...description, manifest });
      artifactFiles = { [DIRECT_RECEIPT]: Buffer.from(JSON.stringify(receipt)),
        '.well-known/typeroll/publication.json': await fs.readFile(path.join(dist, '.well-known/typeroll/publication.json')) };
    } else artifactFiles = await outputFiles(path.join(work, 'dist'));
    const artifact = encodeArtifact(job.identity, artifactFiles);
    const upload = await request('upload', job.token, { ...attempt, artifact_format: 2 });
    if (upload.content_type !== 'application/octet-stream') throw Error('artifact_format_unsupported');
    const uploaded = await fetchImpl(storageUrl(upload.artifact_url), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': upload.content_type }, body: artifact });
    if (!uploaded.ok) throw Error('artifact_upload_failed');
    await request('complete', job.token, { ...attempt, sha256: sha256(artifact) });
    console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'completed', job: job.identity.job_id, branch: job.identity.branch }));
  } catch (error) {
    const code = artifactFailureCode(error.message);
    try { await request('fail', job.token, { ...attempt, code, stage }); } catch { /* A cancelled or superseded attempt cannot change publication state. */ }
    throw Error(`${stage}_${code}`);
  } finally { clearInterval(heartbeat); abort.abort(); await fs.rm(temp, { recursive: true, force: true }); }
}

/** Return only fixed diagnostics or existing safe codes, never file paths or credentials. */
export function artifactFailureCode(message) {
  if (['Static output exceeds the size limit', 'Static artifact exceeds the size limit', 'build_output_limit'].includes(message)) return 'static_output_size_limit';
  if (message === 'Invalid build file path') return 'invalid_static_path';
  if (message === 'Invalid static output file') return 'invalid_static_file';
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : 'build_failed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!process.env.TYPEROLL_RUNNER_TOKEN) console.log('Typeroll setup pending. Return to Publishing and select Finish build setup.');
    else await executeBuild(JSON.parse(await fs.readFile(new URL('./engine.json', import.meta.url), 'utf8')), process.env.TYPEROLL_RUNNER_TOKEN); }
  catch (error) { console.error('TYPEROLL_BUILD_FAILED ' + (/^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : 'build_failed')); process.exitCode = 1; }
}
