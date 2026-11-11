// The published REST reference is generated from the MCP tools: every tool
// that is not a bundled-documentation reader calls the REST API, and the page
// in the docs site matches what the tools do today.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../src/server';
import { LOCAL_TOOLS, renderRestReference, restReference } from '../src/rest-reference';

// No tool may reach the network while it is observed, even after the recorder
// stops watching a slow handler.
vi.stubGlobal('fetch', async () => new Response('Network is not available in this test', { status: 503 }));

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs-site/src/content/docs/technical/rest-api-reference.md');

describe('REST reference', () => {
  it('maps every MCP tool to the REST API and keeps the published page current', async () => {
    const entries = await restReference();
    expect(entries.filter(entry => !entry.calls.length).map(entry => entry.tool)).toEqual([]);
    expect(entries.length + LOCAL_TOOLS.size).toBe(ALL_TOOLS.length);
    for (const entry of entries) for (const call of entry.calls) expect(call.path).toMatch(/^\/api\//);
    const page = renderRestReference(entries);
    if (process.env.UPDATE_REST_REFERENCE === '1') writeFileSync(PAGE, page);
    expect(readFileSync(PAGE, 'utf8'), 'Run npm run gen:rest -w packages/mcp-server').toBe(page);
  }, 120_000);

  // Moveria (Core 0.3.27): `target` was listed as a body key of
  // /pages/{id}/blocks and `patch` as a body key of PATCH /partials/{id},
  // while the tools put the container in the path and send the fields at
  // the top level. Every row is what REST takes.
  it('lists the REST body the calls actually send', async () => {
    const entries = await restReference();
    const byTool = new Map(entries.map(entry => [entry.tool, entry]));
    const rows = (tool: string, index = 0) => byTool.get(tool)!.variants[index]!.parameters.map(p => `${p.in}:${p.name}`);

    const update = byTool.get('update_block')!;
    expect(update.variants.map(variant => `${variant.calls[0]!.method} ${variant.calls[0]!.path}`)).toEqual([
      'PATCH /api/v1/sites/{siteId}/pages/{page_id}/blocks',
      'PATCH /api/v1/sites/{siteId}/containers/{kind}/{id}/blocks',
    ]);
    expect(rows('update_block', 0)).toEqual(['path:page_id', 'body:block_id', 'body:data', 'body:style_overrides', 'body:route_overrides', 'query:response', 'query:version']);
    expect(rows('update_block', 1)).toEqual(['path:kind', 'path:id', 'body:block_id', 'body:data', 'body:style_overrides', 'body:route_overrides', 'query:response', 'query:version']);

    expect(rows('update_partial')).toEqual(['path:partial_id', 'body:name', 'body:html_content', 'body:blocks', 'body:status', 'body:kind', 'body:…', 'body:save', 'query:version']);
    expect(rows('read_working_copy')).toEqual(['path:kind', 'path:id', 'query:version']);

    // No tool lists `target` or `patch` as a body key it does not send.
    for (const entry of entries) {
      for (const variant of entry.variants) {
        const call = variant.calls[0];
        if (!call) continue;
        for (const parameter of variant.parameters) {
          if (parameter.in === 'body' && (parameter.name === 'target' || parameter.name === 'patch')) {
            expect(call.body, `${entry.tool} ${parameter.name}`).toContain(parameter.name);
          }
        }
      }
    }
  }, 120_000);
});
