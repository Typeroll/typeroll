import crypto from 'node:crypto';

function textResult(payload, toolName) {
  if (payload?.error) throw new Error(`${toolName} returned an MCP error`);
  if (payload?.result?.isError) throw new Error(`${toolName} returned a tool error`);
  const text = payload?.result?.content?.find((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${toolName} returned no text result`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned invalid JSON content`);
  }
}

export async function callHostedMcp({ fetchImpl = fetch, portalUrl, apiKey, name, args = {} }) {
  const response = await fetchImpl(`${portalUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  return textResult(await response.json(), name);
}

export async function runAgentJourney({
  fetchImpl = fetch,
  portalUrl,
  apiKey,
  runId = crypto.randomBytes(6).toString('hex'),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const call = (name, args) => callHostedMcp({ fetchImpl, portalUrl, apiKey, name, args });
  let branchId;
  try {
    const created = await call('create_branch', { name: `E2E agent ${runId}` });
    branchId = created?.version?.id;
    if (!branchId?.startsWith('e2e-agent-')) throw new Error('create_branch returned an unexpected branch id');

    const marker = `Typeroll E2E agent journey ${runId}`;
    await call('update_page', {
      page_id: 'home',
      patch: { seo_description: marker },
      save: true,
      version: branchId,
    });
    const read = await call('read_page', { page_id: 'home', version: branchId });
    if (read?.page?.seo_description !== marker) throw new Error('read_page did not return the saved branch change');

    const preview = await call('get_preview_link', { page_id: 'home', version: branchId });
    const previewUrl = preview?.url ?? preview?.preview_url;
    if (typeof previewUrl !== 'string' || !previewUrl.startsWith(`${portalUrl}/preview/`)) {
      throw new Error('get_preview_link returned an unexpected target');
    }
    const previewResponse = await fetchImpl(previewUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!previewResponse.ok) throw new Error(`branch preview returned HTTP ${previewResponse.status}`);

    const deployment = await call('trigger_deploy', { dry_run: true, version: branchId });
    const jobId = deployment?.job_id;
    if (!jobId) throw new Error('trigger_deploy returned no job id');
    let terminal;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await call('get_deploy_status', { job_id: jobId });
      terminal = status?.job?.status;
      if (terminal === 'succeeded' || terminal === 'failed') break;
      await wait(5_000);
    }
    if (terminal !== 'succeeded') throw new Error(`dry-run deploy ended in ${terminal ?? 'timeout'}`);
    return { branchId, preview: 'verified', dryRunDeploy: 'succeeded' };
  } finally {
    if (branchId) await call('delete_branch', { version_id: branchId });
  }
}
