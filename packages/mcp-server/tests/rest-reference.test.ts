// The published REST reference is generated from the MCP tools: every tool
// that is not a bundled-documentation reader calls the REST API, and the page
// in the docs site matches what the tools do today.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../src/server';
import { LOCAL_TOOLS, renderRestReference, restReference } from '../src/rest-reference';

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
});
