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

test('publishes the bounded fixture and waits for the temporary address response header', async () => {
  const calls = [];
  let deployPolls = 0;
  let diagnostics = 0;
  const result = await runFallbackIndexingJourney({
    portalUrl: 'https://cms.example.test',
    apiKey: 'secret',
    siteId: 'journey-site',
    expectedFallbackOrigin: 'https://e2e.sites.example.test',
    wait: async () => {},
    fetchImpl: async (url, init) => {
      if (url === 'https://e2e.sites.example.test') {
        if (diagnostics === 1) throw new TypeError('fetch failed');
        return new Response('', {
          status: 200,
          headers: { 'X-Robots-Tag': 'noindex, nofollow' },
        });
      }
      const request = JSON.parse(init.body);
      const { name, arguments: args } = request.params;
      calls.push({ name, args });
      if (name === 'get_site') return mcpResponse({ id: 'journey-site' });
      if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
      if (name === 'get_deploy_status') {
        deployPolls += 1;
        return mcpResponse({ job: { status: deployPolls === 1 ? 'running' : 'succeeded' } });
      }
      if (name === 'check_site_indexing') {
        diagnostics += 1;
        return mcpResponse({
          targets: [{
            kind: 'production',
            origin: 'https://e2e.sites.example.test',
            expected: 'noindex',
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

  assert.deepEqual(calls.slice(0, 2), [
    { name: 'get_site', args: {} },
    { name: 'trigger_deploy', args: { environment: 'production', allow_unsaved: true } },
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
    siteId: 'journey-site',
    expectedFallbackOrigin: 'https://e2e.sites.example.test',
    wait: async () => {},
    indexingAttempts: 12,
    fetchImpl: async (url, init) => {
      if (url === 'https://e2e.sites.example.test') return new Response('', { status: 200 });
      const request = JSON.parse(init.body);
      const { name } = request.params;
      if (name === 'get_site') return mcpResponse({ id: 'journey-site' });
      if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
      if (name === 'get_deploy_status') return mcpResponse({ job: { status: 'succeeded' } });
      return mcpResponse({
        targets: [{
          kind: 'production', origin: 'https://e2e.sites.example.test', expected: 'noindex', reachable: true,
          head_status: 200, get_status: 200, header_noindex: false, x_robots_tag: null,
          issues: ['missing header'],
        }],
      });
    },
  }), /did not become observable/);
});

test('never publishes saved content through a key for another site', async () => {
  const calls = [];
  await assert.rejects(runFallbackIndexingJourney({
    portalUrl: 'https://cms.example.test', apiKey: 'secret', siteId: 'journey-site',
    expectedFallbackOrigin: 'https://e2e.sites.example.test',
    fetchImpl: async (_url, init) => {
      const { name } = JSON.parse(init.body).params;
      calls.push(name);
      if (name === 'get_site') return mcpResponse({ id: 'customer-site' });
      throw new Error(`Unexpected tool ${name}`);
    },
  }), /bound to journey-site/);
  assert.deepEqual(calls, ['get_site']);
});

test('does not accept an indexable target at the temporary address', async () => {
  await assert.rejects(runFallbackIndexingJourney({
    portalUrl: 'https://cms.example.test', apiKey: 'secret', siteId: 'journey-site',
    expectedFallbackOrigin: 'https://e2e.sites.example.test',
    wait: async () => {}, indexingAttempts: 2,
    fetchImpl: async (url, init) => {
      if (url === 'https://e2e.sites.example.test') return new Response('', { status: 200, headers: { 'X-Robots-Tag': 'noindex' } });
      const { name } = JSON.parse(init.body).params;
      if (name === 'get_site') return mcpResponse({ id: 'journey-site' });
      if (name === 'trigger_deploy') return mcpResponse({ job_id: 'job-1' });
      if (name === 'get_deploy_status') return mcpResponse({ job: { status: 'succeeded' } });
      return mcpResponse({ targets: [{ kind: 'production', origin: 'https://e2e.sites.example.test', expected: 'indexable', reachable: true, header_noindex: true }] });
    },
  }), /did not become observable/);
});
