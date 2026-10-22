import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

test('authenticated deployed MCP smoke rejects old domain catalogs', async t => {
  for (const stale of [false, true]) {
    let lists = 0;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (request.method === 'initialize') return res.end(JSON.stringify({ result: { serverInfo: { name: 'synthetic' }, protocolVersion: '2025-06-18' } }));
      assert.equal(req.url, '/api/mcp?tools=full'); lists++;
      res.end(JSON.stringify({ result: { tools: [
        { name: 'set_publishing_domains', inputSchema: { properties: stale ? {} : { redirect_hosts: { type: 'array', items: { type: 'string' }, maxItems: 4 } } } },
        { name: 'approve_publishing_domain_cutover', inputSchema: { properties: { accept_validation_window: { type: 'boolean' } } } },
      ] } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/smoke-mcp.mjs', `http://127.0.0.1:${server.address().port}`], {
        env: { ...process.env, MCP_SMOKE_API_KEY: 'synthetic-not-a-real-key' }, stdio: 'pipe',
      });
      child.stdout.resume(); child.stderr.resume(); child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(code, stale ? 1 : 0);
    assert.equal(lists, 1);
    await new Promise(resolve => server.close(resolve));
  }
});
