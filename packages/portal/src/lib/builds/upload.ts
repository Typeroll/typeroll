import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { findWranglerBin } from '../hosting/cloudflare-pages';
import { withCloudflareCredential } from '../publishing/cloudflare-oauth';
import { assertFilePath } from './contract.mjs';
import { findPublicationDeployment, type ProviderClient } from '../publishing/providers.mjs';
import { ConnectionError } from '../publishing/connections';

/** The official uploader sees only the selected hosting credential and verified static files. */
export async function uploadStaticBuild(client: ProviderClient, target: { org: string; group: string; account: string; project: string; branch: string; commit: string }, files: Record<string, Buffer>) {
  if (!/^[a-f0-9]{32}$/.test(target.account) || !/^[a-z0-9-]{1,58}$/.test(target.project) || !/^main$|^version-[a-z0-9-]{1,128}$/.test(target.branch) || !/^[a-f0-9]{40}$/.test(target.commit)) throw new Error('Invalid static deployment target');
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-static-')), dist = path.join(temp, 'dist');
  try {
    await fs.mkdir(path.join(temp, 'home')); await fs.symlink('/dev/null', path.join(temp, 'wrangler.log'));
    for (const [name, bytes] of Object.entries(files)) {
      assertFilePath(name, { artifact: true }); const file = path.join(dist, name);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    const binary = findWranglerBin();
    await withCloudflareCredential(target.org, target.group, token => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [binary, 'pages', 'deploy', dist, `--project-name=${target.project}`, `--branch=${target.branch}`, `--commit-hash=${target.commit}`, '--commit-dirty=false'],
        { cwd: temp, env: { PATH: process.env.PATH, HOME: path.join(temp, 'home'), CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: target.account,
          CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(temp, 'wrangler.log') }, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
      child.once('error', () => { clearTimeout(timer); reject(new ConnectionError('The static uploader could not start.', 502, 'static_upload_start_failed')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new ConnectionError('Cloudflare could not accept the static upload. Retry the publication.', 502, 'static_upload_failed')); });
    }));
    const deployment = await findPublicationDeployment(client, `/accounts/${target.account}/pages/projects/${target.project}`, target);
    if (!deployment || deployment.latest_stage?.status !== 'success') throw new ConnectionError('The upload finished without a confirmed deployment identity. Check Cloudflare before retrying.', 502, 'static_upload_uncertain');
    return deployment;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
