import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const script = 'packages/mcp-server/scripts/build-plugins.mjs';
test('packages the same editing recipe for two clients with a self-hosted OAuth endpoint', async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'typeroll-plugin-test-'));
  try {
    execFileSync(process.execPath, [script, output, 'https://cms.example.test/api/mcp']);
    const skill = readFileSync('packages/mcp-server/skills/tr-edit-site.md', 'utf8');
    for (const client of ['openai', 'claude']) {
      const zip = await JSZip.loadAsync(readFileSync(path.join(output, `typeroll-${client}.zip`)));
      assert.equal(await zip.file('skills/tr-edit-site/SKILL.md').async('string'), skill + '\n');
      const server = JSON.parse(await zip.file(client === 'openai' ? 'mcp.json' : '.mcp.json').async('string'));
      assert.deepEqual(Object.keys(server.mcpServers), ['typeroll']);
      assert.equal(server.mcpServers.typeroll.url, 'https://cms.example.test/api/mcp');
      assert.equal(server.mcpServers.typeroll.headers, undefined);
      const manifest = JSON.parse(await zip.file(client === 'openai' ? 'plugin.json' : '.claude-plugin/plugin.json').async('string'));
      assert.equal(manifest.version, JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8')).version);
      assert.equal(Object.keys(zip.files).some(file => /hooks|app-directory|app-attribution/.test(file)), false);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
});
test('refuses a plugin endpoint carrying credentials or an insecure scheme', () => {
  for (const endpoint of ['http://cms.example.test/api/mcp', 'https://user:secret@cms.example.test/api/mcp', 'https://cms.example.test/api/mcp?token=test']) {
    assert.throws(() => execFileSync(process.execPath, [script, '/tmp/unused-typeroll-plugin', endpoint], { stdio: 'pipe' }), /HTTPS/);
  }
});
