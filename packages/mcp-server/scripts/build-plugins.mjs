import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, '../../temp/agent-plugins'));
const endpoint = new URL(process.argv[3] || 'https://app.typeroll.com/api/mcp');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/mcp') {
  throw new Error('Use your portal HTTPS /api/mcp URL, without credentials or query parameters.');
}
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = { name: 'typeroll', version, description: 'Edit Typeroll CMS pages, create reusable design components and preview changes on one selected site.' };
const recipe = await readFile(path.join(root, 'skills/tr-edit-site.md'), 'utf8');
for (const client of ['openai', 'claude']) {
  const files = {
    'skills/tr-edit-site/SKILL.md': recipe,
    'README.md': `# Typeroll CMS\n\nPersonal OAuth connection: ${endpoint}\n\nConfirm one site before editing. Deeper recipes are loaded on demand through MCP.\nThis package is prepared for review; a package does not imply directory approval.\n`,
    ...(client === 'openai' ? {
      'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', ...manifest }, null, 2),
      'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { typeroll: { type: 'streamable-http', url: endpoint.href } } }, null, 2),
    } : {
      '.claude-plugin/plugin.json': JSON.stringify(manifest, null, 2),
      '.mcp.json': JSON.stringify({ mcpServers: { typeroll: { type: 'http', url: endpoint.href } } }, null, 2),
    }),
  };
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) {
    const destination = path.join(output, client, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body + '\n');
    zip.file(name, body + '\n', { date: new Date('2026-01-01T00:00:00Z') });
  }
  await writeFile(path.join(output, `typeroll-${client}.zip`), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
console.log(`Prepared OpenAI and Claude plugin packages in ${output}`);
