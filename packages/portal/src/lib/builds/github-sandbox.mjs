import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BWRAP_URL, BWRAP_SHA, responseBytes, sandboxBinary } from './executor.mjs';
import { sha256 } from './contract.mjs';

// Upstream's stacked child profile denies capabilities after bwrap creates the sandbox.
export const APPARMOR_URL = 'https://gitlab.com/apparmor/apparmor/-/raw/v4.0.2/profiles/apparmor/profiles/extras/bwrap-userns-restrict';
export const APPARMOR_SHA = 'a964037f6cf0df1099f14226b037eaedde6237c86e715188e93eb460b30be859';

export function assertGithubBootstrapEnvironment(env, platform, architecture, uid) {
  if (platform !== 'linux' || architecture !== 'x64' || uid !== 0 || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw Error('github_hosted_bootstrap_required');
  }
}

/** Provision trusted host support before any build source runs, only on an ephemeral GitHub VM. */
export async function prepareGithubSandbox() {
  assertGithubBootstrapEnvironment(process.env, process.platform, process.arch, process.getuid?.());
  const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
  if ((await fs.readFile(restriction, 'utf8')).trim() !== '1') throw Error('github_userns_restriction_required');
  for (const override of ['/etc/apparmor.d/local/bwrap-userns-restrict', '/etc/apparmor.d/local/unpriv_bwrap']) {
    try { await fs.lstat(override); throw Error('existing_apparmor_override'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const get = async (url, digest, limit) => {
    const bytes = await responseBytes(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }), limit);
    if (sha256(bytes) !== digest) throw Error('github_sandbox_integrity_failed');
    return bytes;
  };
  const [deb, profile] = await Promise.all([get(BWRAP_URL, BWRAP_SHA, 100000), get(APPARMOR_URL, APPARMOR_SHA, 16384)]);
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-github-sandbox-'));
  try {
    await fs.writeFile(path.join(temp, 'sandbox.deb'), deb, { mode: 0o600 });
    execFileSync('dpkg-deb', ['-x', path.join(temp, 'sandbox.deb'), temp], { stdio: 'pipe', timeout: 30000 });
    const binary = await fs.readFile(path.join(temp, 'usr/bin/bwrap'));
    for (const [name, bytes, mode] of [['/usr/bin/bwrap', binary, 0o755], ['/etc/apparmor.d/bwrap-userns-restrict', profile, 0o644]]) {
      try {
        await fs.writeFile(name, bytes, { flag: 'wx', mode });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(name);
        if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o6022) || sha256(await fs.readFile(name)) !== sha256(bytes)) throw Error('github_sandbox_install_conflict');
      }
    }
    execFileSync('/sbin/apparmor_parser', ['--replace', '--skip-read-cache', '/etc/apparmor.d/bwrap-userns-restrict'], { stdio: 'pipe', timeout: 30000 });
    if (await sandboxBinary(path.join(temp, 'usr/bin/bwrap')) !== '/usr/bin/bwrap' || (await fs.readFile(restriction, 'utf8')).trim() !== '1') throw Error('github_sandbox_setup_failed');
    console.log('TYPEROLL_GITHUB_SANDBOX_READY');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareGithubSandbox(); }
  catch (error) { console.error(/^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'github_sandbox_bootstrap_failed'); process.exitCode = 1; }
}
