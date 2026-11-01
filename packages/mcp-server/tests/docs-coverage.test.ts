// Every MCP tool must be documented. The public docs and their llms.txt are
// how people and agents learn a tool exists, so a tool that ships without a
// docs entry fails here.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { TyperollClient } from '../src/client.js';

// Tools that may still ship without docs. This list may only shrink: add the
// docs entry and remove the name. Never add a new tool here.
const UNDOCUMENTED_TOOLS = new Set<string>([]);

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs-site/src/content/docs');
const docs = readdirSync(docsRoot, { recursive: true })
  .map(String)
  .filter(file => /\.mdx?$/.test(file))
  .map(file => readFileSync(path.join(docsRoot, file), 'utf8'))
  .join('\n');
const documented = (name: string) => new RegExp('`' + name + '(?:`|\\()').test(docs);

async function toolNames(options: Parameters<typeof buildServer>[0]): Promise<string[]> {
  const server = buildServer(options);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'docs-coverage', version: '1' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map(tool => tool.name);
}

describe('MCP tool documentation', () => {
  const client = new TyperollClient({ baseUrl: 'https://unused.test', apiKey: 'typeroll_live_x_y' });

  it('documents every tool in the full catalog and the personal-connection catalog', async () => {
    const names = new Set([
      ...await toolNames({ client, fixedSiteId: 'site' }),
      ...await toolNames({ client, selection: { select: async () => ({}), resolve: async () => ({ client, siteId: 'site', permission: 'read' }) } }),
    ]);
    expect(names.size).toBeGreaterThan(200);
    const missing = [...names].filter(name => !documented(name) && !UNDOCUMENTED_TOOLS.has(name)).sort();
    expect(missing, 'Document these tools in packages/docs-site/src/content/docs (tools reference)').toEqual([]);
  });

  it('keeps the allowlist to real, still undocumented tools', async () => {
    const names = new Set(await toolNames({ client, fixedSiteId: 'site' }));
    for (const name of UNDOCUMENTED_TOOLS) {
      expect(names.has(name), `${name} is not a tool; remove it from UNDOCUMENTED_TOOLS`).toBe(true);
      expect(documented(name), `${name} is documented now; remove it from UNDOCUMENTED_TOOLS`).toBe(false);
    }
  });
});
