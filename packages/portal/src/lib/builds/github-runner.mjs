import fs from 'node:fs/promises';
import { executeBuild } from './executor.mjs';

// This trusted supervisor is generated separately from all customer build source.
try {
  if (process.getuid?.() === 0 || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw Error('github_hosted_runner_required');
  const config = JSON.parse(await fs.readFile(new URL('./engine.json', import.meta.url), 'utf8'));
  const key = process.env.TYPEROLL_TASK_KEY, nonce = process.env.TYPEROLL_DISPATCH_NONCE;
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || !/^[a-f0-9-]{36}$/.test(nonce ?? '')) throw Error('invalid_build_dispatch');
  const claim = `${config.origin}/api/builds/runner/${config.org_id}/claim`;
  const request = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '');
  if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com') || request.username || request.password || request.port) throw Error('invalid_github_identity_endpoint');
  request.searchParams.set('audience', claim);
  const response = await fetch(request, { redirect: 'error', headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('github_identity_request_failed');
  const { value: identity } = await response.json();
  if (typeof identity !== 'string' || identity.length > 16384) throw Error('github_identity_response_invalid');
  await executeBuild(config, 'github-oidc', async (url, init) => {
    if (String(url) !== claim) return fetch(url, init);
    return fetch(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity}` },
      body: JSON.stringify({ ...JSON.parse(init.body), provider: 'github', key, dispatch_nonce: nonce }) });
  });
} catch (error) {
  console.error('TYPEROLL_BUILD_FAILED ' + (/^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : 'github_build_failed'));
  process.exitCode = 1;
}
