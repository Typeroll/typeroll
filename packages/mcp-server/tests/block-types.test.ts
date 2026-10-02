// Request shapes and permission classes for the block type tools: authoring
// (admin), validation and preview (read: they write nothing), starters,
// usage and .tcblocks packages. Each tool is one REST call.

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type BuildServerOptions } from '../src/server.js';
import { TyperollClient } from '../src/client.js';
import { blockTypeTools } from '../src/tools/block-types.js';

interface Recorded { url: string; method: string; body: unknown }

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(client => client.close())); });

async function connect(mode: 'full' | 'compact' = 'full', overrides: Partial<BuildServerOptions> = {}, respond: () => Response = () => Response.json({ ok: true })) {
  const calls: Recorded[] = [];
  const api = new TyperollClient({
    baseUrl: 'https://portal.test', apiKey: 'typeroll_live_x_y',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond();
    },
  });
  const server = buildServer({ client: api, fixedSiteId: 'site', toolMode: mode, ...overrides });
  const client = new Client({ name: 'block-types-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); connections.push(client);
  return { client, calls };
}

const definition = {
  name: 'icon_list', label: 'Icon list',
  schema: [{ name: 'items', type: 'array', label: 'Items', fields: [{ name: 'title', type: 'text', label: 'Title' }, { name: 'link', type: 'link', label: 'Link' }] }],
  composition: [{ id: 'list', type: 'core/repeater', data: { items: '{{props.items}}' }, children: [{ id: 't', type: 'core/text', data: { text: '{{item.title}}' } }] }],
};

const cases: Array<[string, Record<string, unknown>, string, string, unknown?]> = [
  ['list_block_type_starters', {}, 'GET', '/api/v1/sites/site/block-types/starters'],
  ['validate_block_type', { definition }, 'POST', '/api/v1/sites/site/block-types/validate', definition],
  ['validate_block_type', { definition: { label: 'New' }, type_id: 'icon_list', version: 'redesign' }, 'POST', '/api/v1/sites/site/block-types/validate?type_id=icon_list&version=redesign', { label: 'New' }],
  ['preview_block_type', { definition, data: { items: [{ title: 'A' }] }, render_version: 4 }, 'POST', '/api/v1/sites/site/block-types/preview', { definition, data: { items: [{ title: 'A' }] }, render_version: 4 }],
  ['preview_block_type', { type_id: 'icon_list' }, 'POST', '/api/v1/sites/site/block-types/preview', { type_id: 'icon_list', definition: {} }],
  ['create_block_type', { ...definition, description: 'Benefits', styles: ':scope { gap: 1rem }' }, 'POST', '/api/v1/sites/site/block-types?origin=ai', { ...definition, description: 'Benefits', styles: ':scope { gap: 1rem }' }],
  ['update_block_type', { type_id: 'icon_list', schema: definition.schema, renames: { 'items.label': 'title' }, confirm_data_loss: true }, 'PATCH', '/api/v1/sites/site/block-types/icon_list', { schema: definition.schema, renames: { 'items.label': 'title' }, confirm_data_loss: true }],
  ['delete_block_type', { type_id: 'icon_list' }, 'DELETE', '/api/v1/sites/site/block-types/icon_list'],
  ['find_pages_using_block_type', { type_id: 'icon_list' }, 'GET', '/api/v1/sites/site/block-types/icon_list/usage'],
  ['import_block_types', { zip_base64: 'UEs=', on_conflict: 'rename' }, 'POST', '/api/v1/sites/site/blocks/import', { zip_base64: 'UEs=', on_conflict: 'rename' }],
  ['import_block_types', { zip_base64: 'UEs=' }, 'POST', '/api/v1/sites/site/blocks/import', { zip_base64: 'UEs=' }],
];

describe('block type tools', () => {
  for (const [name, args, method, path, body] of cases) {
    it(`${name} calls ${method} ${path.split('?')[0]}`, async () => {
      const { client, calls } = await connect();
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(calls[0]!.url).toBe(`https://portal.test${path}`);
      if (body !== undefined) expect(calls[0]!.body).toEqual(body);
    });
  }

  it('classifies authoring as admin, validation and preview as read', async () => {
    const { client } = await connect('compact');
    const effect = async (name: string) => JSON.parse((await client.callTool({ name: 'describe_tool', arguments: { name } }) as { content: Array<{ text: string }> }).content[0]!.text).effect;
    for (const name of ['create_block_type', 'update_block_type', 'delete_block_type', 'import_block_types']) expect(await effect(name)).toBe('admin');
    for (const name of ['validate_block_type', 'preview_block_type', 'list_block_type_starters', 'list_block_types', 'read_block_type', 'find_pages_using_block_type']) expect(await effect(name)).toBe('read');
  });

  it('refuses authoring on a write share before any request, but validates and previews', async () => {
    const { client, calls } = await connect('full', { fixedSiteId: undefined, allowedSites: [{ siteId: 'shared', permission: 'write' }] });
    const denied = await client.callTool({ name: 'create_block_type', arguments: { site_id: 'shared', ...definition } });
    expect(denied.isError).toBe(true);
    expect(calls).toEqual([]);
    for (const name of ['validate_block_type', 'preview_block_type']) {
      expect((await client.callTool({ name, arguments: { site_id: 'shared', definition } })).isError).not.toBe(true);
    }
    expect(calls.map(call => call.url)).toEqual([
      'https://portal.test/api/v1/sites/shared/block-types/validate',
      'https://portal.test/api/v1/sites/shared/block-types/preview',
    ]);
  });

  it('passes validation problems through on a 400', async () => {
    const problems = [{ severity: 'error', path: '/schema/0/fields/1/type', message: 'type must be one of …' }];
    const { client } = await connect('full', {}, () => Response.json({ error: '/schema/0/fields/1/type: type must be one of …', problems }, { status: 400 }));
    const result = await client.callTool({ name: 'create_block_type', arguments: definition }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 400, body: { problems } });
  });

  it('describes composed and template types, bindings, sections, link fields, scoped CSS and admin', () => {
    const text = (name: string) => blockTypeTools.find(tool => tool.name === name)!.description;
    for (const needle of ['{{props.title}}', '{{item.title}}', '{{#each items}}', '{{^field}}', '{{#link field class=', 'link (', ':scope', 'ADMIN', 'composition']) {
      expect(text('create_block_type')).toContain(needle);
    }
    expect(text('update_block_type')).toContain('renames');
    expect(text('update_block_type')).toContain('confirm_data_loss');
    expect(text('find_pages_using_block_type')).not.toContain('HTML-mode');
    expect(text('find_pages_using_block_type')).toContain('block_types');
  });

  it('list_block_types summarises composed types without their composition', async () => {
    const { client } = await connect('full', {}, () => Response.json({ block_types: [{ ...definition, id: 'icon_list', styles: 'x', styles_compiled: 'y' }] }));
    const result = await client.callTool({ name: 'list_block_types', arguments: {} }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text) as { block_types: Array<Record<string, unknown>> };
    expect(body.block_types[0]).toMatchObject({ id: 'icon_list', composed: true, schema: definition.schema });
    expect(body.block_types[0]).not.toHaveProperty('composition');
    expect(body.block_types[0]).not.toHaveProperty('styles_compiled');
  });
});
