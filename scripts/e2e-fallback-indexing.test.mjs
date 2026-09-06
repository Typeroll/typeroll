import assert from 'node:assert/strict';
import test from 'node:test';

import { runFallbackIndexingJourney } from './lib/e2e-fallback-indexing.mjs';

function mcpResponse(value) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 'test',
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('publishes the bounded fixture and waits for the fallback response header', async () => {
  const calls = [];
  let deployPolls = 0;
  let diagnostics = 0;
  const result = await runFallbackIndexingJourney({
    portalUrl: 'https://cms.example.test',
    apiKey: 'secret',
    expectedFallbackOrigin: 'https://e2e-core-site.sites-staging.typeroll.com',
    wait: async () => {},
    fetchImpl: async (url, init) => {
      if (url === 'https://e2e.sites.example.test') {
        return new Response('', {
          status: 200,
          headers: diagnostics > 1 ? { 'X-Robots-Tag': 'noindex, nofollow' } : {},
        });
      }
      const request = JSON.parse(init.body);
      const { name, arguments: args } = request.params;
      calls.push({ name, args });
      if (name === 'get_site') return mcpResponse({ id: 'e2e-core-site' });
      if (name === 'update_site') return mcpResponse({
        urls: { fallback: 'https://e2e-core-site.sites-staging.typeroll.com' },
      });
      if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
      if (name === 'get_deploy_status') {
        deployPolls += 1;
        return mcpResponse({ job: { status: deployPolls === 1 ? 'running' : 'succeeded' } });
      }
      if (name === 'check_site_indexing') {
        diagnostics += 1;
        return mcpResponse({
          targets: [{
            kind: 'fallback',
            origin: 'https://e2e.sites.example.test',
            reachable: true,
            head_status: 200,
            get_status: 200,
            header_noindex: diagnostics > 1,
            x_robots_tag: diagnostics > 1 ? 'noindex, nofollow' : null,
            issues: [],
          }],
        });
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  });

  assert.deepEqual(calls.slice(0, 3), [
    { name: 'get_site', args: {} },
    { name: 'update_site', args: { slug: 'e2e-core-site', domain: '' } },
    { name: 'trigger_deploy', args: { environment: 'production' } },
  ]);
  assert.equal(calls.filter((call) => call.name === 'get_deploy_status').length, 2);
  assert.equal(calls.filter((call) => call.name === 'check_site_indexing').length, 2);
  assert.deepEqual(result, {
    jobId: 'job-1',
    origin: 'https://e2e.sites.example.test',
    headStatus: 200,
    getStatus: 200,
    xRobotsTag: 'noindex, nofollow',
  });
});

test('fails closed when the deployed fallback never receives noindex', async () => {
  await assert.rejects(runFallbackIndexingJourney({
    portalUrl: 'https://cms.example.test',
    apiKey: 'secret',
    expectedFallbackOrigin: 'https://e2e-core-site.sites-staging.typeroll.com',
    wait: async () => {},
    fetchImpl: async (url, init) => {
      if (url === 'https://e2e.sites.example.test') return new Response('', { status: 200 });
      const request = JSON.parse(init.body);
      const { name } = request.params;
      if (name === 'get_site') return mcpResponse({ id: 'e2e-core-site' });
      if (name === 'update_site') return mcpResponse({
        urls: { fallback: 'https://e2e-core-site.sites-staging.typeroll.com' },
      });
      if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
      if (name === 'get_deploy_status') return mcpResponse({ job: { status: 'succeeded' } });
      return mcpResponse({
        targets: [{
          kind: 'fallback', origin: 'https://e2e.sites.example.test', reachable: true,
          head_status: 200, get_status: 200, header_noindex: false, x_robots_tag: null,
          issues: ['missing header'],
        }],
      });
    },
  }), /did not become observable/);
});
