import { verifyCandidateBatch } from './static-verifier.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeStaticOutput, validateDirectReceipt, availablePagesAssets, retainPagesAssets, reusedMediaReceipt, mergeDirectReceipt, DIRECT_RECEIPT } from './direct-upload.mjs';
import { BUILD_RUNTIME, MAX_SOURCE_BYTES, MAX_ARTIFACT_BYTES, MAX_RENDER_CACHE_BYTES, MAX_SEO_REPORT_BYTES, decodeSource, decodeArtifact, encodeArtifact, sha256, assertFilePath, renderReport, seoReport, outputDigest } from './contract.mjs';

// The rolling package pool removes superseded packages; retain this exact verified binary.
/**
 * Where the sandbox binary comes from, in order: upstream, then our mirror.
 *
 * Every publication build downloads this and runs the customer's build inside
 * it, so whoever serves it is a hard availability dependency for publishing —
 * not just for releases. On 2026-09-22 snapshot.ubuntu.com returned 5xx for
 * hours and no customer site could be published.
 *
 * Upstream stays first deliberately. A mirror that is tried first becomes the
 * normal path for every build including self-hosted ones, so a mistake in our
 * bucket — wrong object, changed access, misconfiguration — would land on
 * everyone's ordinary case. Reached only after upstream has already failed,
 * its blast radius is exactly the outage it exists for.
 *
 * Neither source is trusted. BWRAP_SHA is verified against whichever answered,
 * and a source serving different bytes throws rather than falling through to
 * one that agrees: an outage may be retried past, a substitution must not be.
 */
export const BWRAP_SOURCES = [
  'https://snapshot.ubuntu.com/ubuntu/20260918T000000Z/pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.1_amd64.deb',
  'https://pub-5c1272ea84a340b9b7893579653e34ab.r2.dev/ubuntu/20260918T000000Z/bubblewrap_0.9.0-1ubuntu0.1_amd64.deb',
];
/** Canonical upstream, kept exported for anything naming a single origin. */
export const BWRAP_URL = BWRAP_SOURCES[0];
export const BWRAP_SHA = '1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a';

export function mediaCheckpointPolicy(kind, progress, startedAt, deadline, now = Date.now()) {
  const finished = progress.cursor === progress.total;
  // A publication needs time for materialization, rendering and upload after
  // preparation. A completed private preparation only returns a small receipt.
  const keepLease = (kind === 'media_preparation' && finished) || now < Math.min(startedAt + 12 * 60_000, deadline - 120_000);
  return { continueBuild: finished && keepLease, keepLease };
}

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
  return { format: 'module', shortCircuit: true, source: ${JSON.stringify("import fs from 'node:fs/promises'; import path from 'node:path'; export async function prepareMedia(publication) { const prepared=JSON.parse(await fs.readFile('/work/.typeroll-runner/prepared.json','utf8')); if(prepared.publication_id!==publication.publication_id || !Array.isArray(prepared.media) || !Array.isArray(prepared.files))throw Error('prepared_media_identity_mismatch'); for(const file of prepared.files)if(!file.reused&&!path.resolve(file.source).startsWith('/work/.publication-media/'))throw Error('prepared_media_path_mismatch'); publication.media=prepared.media; return prepared.files; }")} };
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
async function readSeoReport(work, publicationId) {
  const file = path.join(work, '.publication-work/seo-report.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SEO_REPORT_BYTES || !(await fs.realpath(file)).startsWith(work + path.sep)) throw Error('publication_validation_report_invalid');
  return seoReport(JSON.parse(await fs.readFile(file, 'utf8')), publicationId);
}

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
  const job = await request('claim', runnerToken, { protocol: 1, media_batch_access: true, static_verification: true, render_cache: true, asset_cache: true });
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
  let previousAssets, reusableFiles = {}, preparedMediaFiles = [], materializePublication, renderPublication;
  const mediaReport = { reused_files: 0, reused_bytes: 0, materialization_ms: 0, rendering_ms: 0 };
  try {
    await fs.mkdir(work);
    const bytes = await responseBytes(await fetchImpl(storageUrl(job.source_url), { redirect: 'error', signal: AbortSignal.timeout(60000) }), MAX_SOURCE_BYTES);
    const files = decodeSource(bytes, job.identity.source_sha256);
    if (job.kind === 'static_verification') {
      stage = 'verification';
      const plan = JSON.parse(files['verification.json']);
      if (plan.publication_id !== job.identity.publication_id || plan.checks.length !== job.media_total) throw Error('verification_scope_mismatch');
      let cursor = job.media_cursor, downloaded = 0;
      while (cursor < job.media_total) {
        const progress = await verifyCandidateBatch(plan, cursor, { fetchImpl, signal: abort.signal, observe: bytes => { downloaded += bytes; } });
        cursor = progress.cursor;
        const finished = cursor === job.media_total, keepLease = finished || Date.now() < Math.min(startedAt + 12 * 60_000, job.deadline - 120000);
        await request('verification-checkpoint', job.token, { ...attempt, cursor, continue_build: finished, keep_lease: keepLease });
        if (!keepLease) { console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'verification_continuation', job: job.identity.job_id, completed: cursor, total: job.media_total, downloaded_bytes: downloaded })); return; }
      }
      const artifact = encodeArtifact(job.identity, {
        '.well-known/typeroll/publication.json': Buffer.from(JSON.stringify({ id: job.identity.publication_id })),
        'verification.json': Buffer.from(JSON.stringify({ publication_id: job.identity.publication_id, source_sha256: job.identity.source_sha256, completed: job.media_total })),
      });
      const upload = await request('upload', job.token, { ...attempt, artifact_format: 2 });
      const response = await fetchImpl(storageUrl(upload.artifact_url), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'Content-Type': upload.content_type }, body: artifact });
      if (!response.ok) throw Error('artifact_upload_failed');
      await request('complete', job.token, { ...attempt, sha256: sha256(artifact) });
      console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'verified', job: job.identity.job_id, completed: cursor, total: job.media_total, downloaded_bytes: downloaded, peak_rss_kib: process.resourceUsage().maxRSS }));
      return;
    }
    for (const [name, content] of Object.entries(files)) {
      if (name.startsWith('.typeroll-runner/') || name.startsWith('.publication-cache.json')) throw Error('reserved_build_source');
      const target = path.join(work, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' });
    }
    if (job.kind === 'publication' && job.render_cache) {
      try {
        const cached = await responseBytes(await fetchImpl(storageUrl(job.render_cache.url), { redirect: 'error', signal: AbortSignal.timeout(30000) }), MAX_RENDER_CACHE_BYTES);
        if (sha256(cached) !== job.render_cache.sha256) throw Error('render_cache_integrity');
        await fs.writeFile(path.join(work, '.publication-cache.json'), cached, { flag: 'wx' });
      } catch { console.log('TYPEROLL_RENDER_CACHE unavailable; rendering without a baseline'); }
    }
    if (job.kind === 'publication' && job.direct_upload && job.asset_cache) {
      try {
        if (!['org_id', 'site_id', 'version_id'].every(key => job.asset_cache.identity?.[key] === job.identity[key])) throw Error('asset_cache_scope');
        const bytes = await responseBytes(await fetchImpl(storageUrl(job.asset_cache.url), { redirect: 'error', signal: AbortSignal.timeout(30000) }), 8 * 1024 * 1024);
        const cached = decodeArtifact(bytes, job.asset_cache.identity, job.asset_cache.sha256);
        previousAssets = validateDirectReceipt(JSON.parse(cached[DIRECT_RECEIPT].toString('utf8')));
        const grant = await request('direct-upload', job.token, attempt);
        reusableFiles = await availablePagesAssets(previousAssets, grant, fetchImpl);
      } catch { previousAssets = undefined; reusableFiles = {}; console.log('TYPEROLL_MEDIA_CACHE unavailable; downloading required media'); }
    }
    stage = 'sandbox';
    // `sandbox_unavailable` and `sandbox_integrity_failed` are different
    // events: the first is somebody else's server, the second is the bytes at
    // a pinned URL having changed. A publication that reports only an exit
    // code makes an operator read the build path to tell them apart.
    let deb;
    const sandboxFailures = [];
    for (const source of BWRAP_SOURCES) {
      try {
        const response = await fetchImpl(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok) { sandboxFailures.push(`${source} (HTTP ${response.status})`); continue; }
        const bytes = await responseBytes(response, 100000);
        // A source that answers with different bytes is a substitution, not an
        // outage, and must not be retried past to a source that agrees.
        if (sha256(bytes) !== BWRAP_SHA) throw Error(`sandbox_integrity_failed: ${source}`);
        deb = bytes;
        break;
      } catch (error) {
        if (String(error.message).startsWith('sandbox_integrity_failed')) throw error;
        sandboxFailures.push(`${source} (${error.message})`);
      }
    }
    if (!deb) throw Error(`sandbox_unavailable: no source served the pinned artifact — ${sandboxFailures.join('; ')}`);
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
        // Leave two minutes for shutdown and coordinator retries. Every batch
        // is durable even when the provider kills this process between batches.
        const { continueBuild, keepLease } = mediaCheckpointPolicy(job.kind, progress, startedAt, job.deadline);
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
      materializePublication = async reusable => {
        const materializationStarted = Date.now();
        await fs.writeFile(path.join(work, '.typeroll-runner/reusable-media.json'), JSON.stringify(reusable));
        // Only this trusted media stage receives exact publication-scoped object grants.
        if (job.media_access_batched && job.media_total) {
          const prepared = { publication_id: job.identity.publication_id, media: [], files: [] };
          let cursor = 0;
          while (cursor < job.media_total) {
            const access = await request('media-access', job.token, { ...attempt, cursor });
            await fs.writeFile(path.join(work, '.typeroll-runner/materialize.mjs'),
              "import fs from 'node:fs/promises'; import { prepareMediaBatch } from '../scripts/media.mjs'; const publication=JSON.parse(await fs.readFile('/work/publication.json','utf8')); const result=await prepareMediaBatch(publication,'/work'," + cursor + ",{materialize:true,reusableFiles:JSON.parse(await fs.readFile('/work/.typeroll-runner/reusable-media.json','utf8'))}); await fs.writeFile('/work/.typeroll-runner/materialized.json',JSON.stringify(result));");
            await run(['.typeroll-runner/materialize.mjs'], true, { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(access) });
            const result = JSON.parse(await fs.readFile(path.join(work, '.typeroll-runner/materialized.json'), 'utf8'));
            if (result.cursor <= cursor || result.cursor > Math.min(cursor + 100, job.media_total) || result.total !== job.media_total || !Array.isArray(result.files) || !Array.isArray(result.media)) throw Error('media_materialization_scope_mismatch');
            prepared.files.push(...result.files); prepared.media.push(...result.media); cursor = result.cursor;
          }
          const byId = new Map(prepared.media.map(media => [media.id, media]));
          const publication = JSON.parse(files['publication.json']);
          if (publication.media_manifest.entries.some(entry => !byId.has(entry.id))) throw Error('media_materialization_incomplete');
          prepared.media = publication.media.map(media => byId.get(media.id) ?? media);
          preparedMediaFiles = prepared.files;
          // Validate source-provided reuse descriptors against the trusted receipt.
          reusedMediaReceipt(preparedMediaFiles, previousAssets);
          await fs.writeFile(path.join(work, '.typeroll-runner/prepared.json'), JSON.stringify(prepared));
        } else await run(['.typeroll-runner/prepare.mjs'], true, job.media_access ? { TYPEROLL_BUILD_MEDIA_ACCESS: JSON.stringify(job.media_access) } : {});
        mediaReport.materialization_ms += Date.now() - materializationStarted;
      };
      await materializePublication(reusableFiles);
      stage = 'extension_assets';
      await fs.copyFile(new URL('./assets.mjs', import.meta.url), path.join(work, '.typeroll-runner/assets.mjs'));
      await run(['--input-type=module', '-e', "import { prepareAssets } from './.typeroll-runner/assets.mjs'; await prepareAssets('/work');"], true);
      stage = 'rendering';
      await fs.writeFile(path.join(work, '.typeroll-runner/render.mjs'), RENDER_ADAPTER, { flag: 'wx' });
      renderPublication = async () => {
        const renderingStarted = Date.now();
        await run(['.typeroll-runner/render.mjs'], false, { TYPEROLL_BUILD_MEDIA_PREPARED: '/work/.typeroll-runner/prepared.json' });
        mediaReport.rendering_ms += Date.now() - renderingStarted;
      };
      await renderPublication();
    }
    }
    stage = 'artifact';
    let artifactFiles, validation;
    if (job.kind === 'publication' && job.direct_upload) {
      const dist = path.join(work, 'dist');
      let grant = await request('direct-upload', job.token, attempt);
      let reused = reusedMediaReceipt(preparedMediaFiles, previousAssets);
      if (Object.keys(reused.files).length) {
        const available = await availablePagesAssets(reused, grant, fetchImpl);
        if (Object.keys(available).length !== Object.keys(reused.files).length) {
          // Assets may expire while rendering. Rebuild a complete local output;
          // ordinary Wrangler upload then repairs missing files atomically.
          stage = 'media'; await materializePublication({});
          stage = 'rendering'; await renderPublication();
          stage = 'artifact'; reused = reusedMediaReceipt(preparedMediaFiles, previousAssets);
          grant = await request('direct-upload', job.token, attempt);
        }
      }
      const description = await describeStaticOutput(dist);
      validation = await readSeoReport(work, job.identity.publication_id);
      if (!validation.passed || validation.artifact_tree_sha256 !== outputDigest({ ...description.files, ...reused.files })) throw Error('publication_validation_failed');
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
      const receipt = mergeDirectReceipt(description, manifest, reused, grant.target);
      if (!await retainPagesAssets(reused, grant, fetchImpl)) console.log('TYPEROLL_MEDIA_CACHE availability index refresh failed; future builds may download files again');
      mediaReport.reused_files = Object.keys(reused.files).length;
      mediaReport.reused_bytes = Object.values(reused.files).reduce((total, file) => total + file.size, 0);
      artifactFiles = { [DIRECT_RECEIPT]: Buffer.from(JSON.stringify(receipt)),
        '.well-known/typeroll/publication.json': await fs.readFile(path.join(dist, '.well-known/typeroll/publication.json')) };
    } else {
      artifactFiles = await outputFiles(path.join(work, 'dist'));
      if (job.kind === 'publication') {
        validation = await readSeoReport(work, job.identity.publication_id);
        const tree = Object.fromEntries(Object.entries(artifactFiles).map(([name, bytes]) => [name, { sha256: sha256(bytes), size: bytes.length }]));
        if (!validation.passed || validation.artifact_tree_sha256 !== outputDigest(tree)) throw Error('publication_validation_failed');
      }
    }
    const artifact = encodeArtifact(job.identity, artifactFiles);
    const upload = await request('upload', job.token, { ...attempt, artifact_format: 2 });
    if (upload.content_type !== 'application/octet-stream') throw Error('artifact_format_unsupported');
    const uploaded = await fetchImpl(storageUrl(upload.artifact_url), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': upload.content_type }, body: artifact });
    if (!uploaded.ok) throw Error('artifact_upload_failed');
    let cacheHash, report;
    if (job.kind === 'publication') {
      try {
        const reportPath = path.join(work, '.publication-work/render-report.json');
        const stat = await fs.lstat(reportPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || !(await fs.realpath(reportPath)).startsWith(work + path.sep)) throw Error('render_report_invalid');
        report = renderReport(JSON.parse(await fs.readFile(reportPath, 'utf8')));
      } catch { /* Older frozen renderers have no report. */ }
      if (job.render_cache_supported && report) {
        try {
          const cachePath = path.join(work, '.publication-cache.json');
          const stat = await fs.lstat(cachePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RENDER_CACHE_BYTES) throw Error('render_cache_invalid');
          const cached = await fs.readFile(cachePath);
          const grant = await request('render-cache-upload', job.token, attempt);
          const response = await fetchImpl(storageUrl(grant.url), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: cached });
          if (response.ok) cacheHash = sha256(cached);
        } catch { console.log('TYPEROLL_RENDER_CACHE could not save optional baseline'); }
      }
    }
    await request('complete', job.token, { ...attempt, sha256: sha256(artifact), render_cache_sha256: cacheHash, render_report: report, seo_report: validation });
    console.log('TYPEROLL_BUILD_RESULT ' + JSON.stringify({ status: 'completed', job: job.identity.job_id, branch: job.identity.branch, render_report: report, media_report: mediaReport }));
  } catch (error) {
    let validation;
    if (job.kind === 'publication') { try { validation = await readSeoReport(work, job.identity.publication_id); } catch { /* A renderer may fail before validation. */ } }
    const code = validation && !validation.passed ? 'publication_validation_failed' : artifactFailureCode(error.message);
    try { await reportBuildFailure(request, job.token, attempt, { code, stage, validation }); } catch { /* A cancelled or superseded attempt cannot change publication state. */ }
    throw Error(`${stage}_${code}`);
  } finally { clearInterval(heartbeat); abort.abort(); await fs.rm(temp, { recursive: true, force: true }); }
}

/** An explicit HTTP 413 has not committed failure state. Report it once without
 * the rejected diagnostics; never restart the build or retry arbitrary errors. */
export async function reportBuildFailure(request, token, attempt, { code, stage, validation }) {
  try {
    await request('fail', token, { ...attempt, code, stage, ...(validation ? { seo_report: validation } : {}) });
  } catch (error) {
    if (!validation || error.message !== 'coordinator_413') throw error;
    await request('fail', token, { ...attempt, code: 'publication_report_too_large', stage });
  }
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
