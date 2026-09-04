import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentJourney } from './lib/e2e-agent-journey.mjs';

function mcpResponse(value) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 'test',
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function journeyFetch({ failPreview = false } = {}) {
  const calls = [];
  let statusCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://cms.example.test/preview/')) {
      calls.push('preview');
      return new Response('', { status: failPreview ? 500 : 200 });
    }
    const request = JSON.parse(init.body);
    const { name, arguments: args } = request.params;
    calls.push(name);
    if (name === 'create_branch') return mcpResponse({ version: { id: 'e2e-agent-fixed' } });
    if (name === 'read_page') return mcpResponse({ page: { seo_description: 'Typeroll E2E agent journey fixed' } });
    if (name === 'get_preview_link') return mcpResponse({ url: 'https://cms.example.test/preview/e2e-core-site/' });
    if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
    if (name === 'get_deploy_status') {
      statusCalls += 1;
      return mcpResponse({ job: { status: statusCalls === 1 ? 'running' : 'succeeded' } });
    }
    if (name === 'update_page' || name === 'delete_branch') return mcpResponse({ ok: true, args });
    throw new Error(`Unexpected tool ${name}`);
  };
  return { calls, fetchImpl };
}

test('agent journey mutates only a branch, verifies preview/build, and cleans up', async () => {
  const mock = journeyFetch();
  const result = await runAgentJourney({
    portalUrl: 'https://cms.example.test',
    apiKey: 'secret',
    runId: 'fixed',
    fetchImpl: mock.fetchImpl,
    wait: async () => {},
  });
  assert.deepEqual(result, { branchId: 'e2e-agent-fixed', preview: 'verified', dryRunDeploy: 'succeeded' });
  assert.deepEqual(mock.calls, [
    'create_branch', 'update_page', 'read_page', 'get_preview_link', 'preview',
    'trigger_deploy', 'get_deploy_status', 'get_deploy_status', 'delete_branch',
  ]);
});

test('agent journey still cleans its branch when verification fails', async () => {
  const mock = journeyFetch({ failPreview: true });
  await assert.rejects(runAgentJourney({
    portalUrl: 'https://cms.example.test',
    apiKey: 'secret',
    runId: 'fixed',
    fetchImpl: mock.fetchImpl,
    wait: async () => {},
  }), /preview returned HTTP 500/);
  assert.equal(mock.calls.at(-1), 'delete_branch');
});
