// Every MCP tool is a thin wrapper around the REST API. This module runs each
// tool against a recording HTTP client to find the REST calls behind it, so
// the published REST reference is derived from the tools themselves and cannot
// drift from them. Placeholder arguments name each input, for example
// `{page_id}`, and appear as such in the recorded paths.

import { z, type ZodType } from 'zod';
import { TyperollClient } from './client.js';
import { ALL_TOOLS, effectFor } from './server.js';
import type { ToolDef } from './tools/helpers.js';

export interface RestCall { method: string; path: string; query: string[]; body: string[] }
export interface RestParameter { name: string; in: 'path' | 'query' | 'body'; type: string; required: boolean; description: string }
/** One way of calling a tool (a page or a partial, say) and the REST calls and parameters it takes. */
export interface RestVariant { calls: RestCall[]; parameters: RestParameter[] }
export interface RestEntry {
  tool: string;
  effect: 'read' | 'write' | 'admin';
  description: string;
  /** Site routes live under /api/v1/sites/{siteId}/; the rest under /api/v1/. */
  site: boolean;
  /** Every REST call behind the tool, in recording order. */
  calls: RestCall[];
  variants: RestVariant[];
  /** Said before the parameter tables of a tool with more than one way of calling it. */
  note?: string;
}

/** Tools that read bundled documentation and never call the API. */
export const LOCAL_TOOLS = new Set(['read_guide', 'list_skills', 'read_skill']);

const BASE = 'https://portal.invalid';

/** Valid example input for tools that validate more than placeholders satisfy. */
const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  add_recipe_schema: { page_id: '{page_id}', name: 'Pancakes', ingredients: ['Flour'], instructions: ['Mix'] },
  add_event_schema: { page_id: '{page_id}', name: 'Launch', start_date: '2026-06-12T19:00:00+02:00' },
  import_gsc_performance: { property: 'https://example.com/' },
  update_migration_urls: { ids: ['{id}'], patch: { excluded: true } },
  revoke_preview_link: { preview_url: `${'https://portal.invalid'}/preview/{siteId}/?t={token}` },
  search_fonts: { query: 'grotesk', category: 'sans', variable: true },
  set_site_fonts: { heading: 'Fraunces', body: 'Inter', display: null, load: { body: { weights: [300] } } },
  export_package: { selection: { kind: 'collection', block_templates: ['hero'], styles: 'used' }, meta: { id: 'acme-sections', name: 'Acme sections', version: '1.0.0' } },
  inspect_package: { source_url: 'https://example.com/acme-sections-1.0.0.typeroll', options: { design: 'content' } },
  import_package: { source_url: 'https://example.com/acme-sections-1.0.0.typeroll', options: { design: 'content' } },
  create_site: { name: '{name}', id: '{id}', language: 'en', domain: 'example.com', from_site_id: '{from_site_id}', design: 'full', font_licence_confirmed: true },
  delete_site: { confirm_site_id: '{siteId}', confirm_digest: '{confirm_digest}', reason: '{reason}' },
  upload_font: { filename: 'BrandSans-Regular.woff2', data_base64: '{data_base64}', licence_confirmed: true, licence_note: 'Web licence, order 1234' },
};
const SITE = '{siteId}';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeholder(name: string, schema: any): unknown {
  const def = schema?.def ?? schema?._zod?.def;
  switch (def?.type) {
    case 'optional': case 'default': case 'nullable': case 'readonly': case 'catch': case 'prefault': case 'nonoptional':
      return placeholder(name, def.innerType);
    case 'pipe': return placeholder(name, def.in);
    case 'lazy': return placeholder(name, def.getter());
    case 'string':
      if (schema.format === 'url' || /url$/i.test(name)) return `https://example.com/${name}.png`;
      if (schema.format === 'email' || /email$/i.test(name)) return `${name}@example.com`;
      return `{${name}}`;
    case 'number': case 'int': case 'bigint': return 1;
    case 'boolean': return true;
    case 'enum': return Object.values(def.entries)[0];
    case 'literal': return def.values[0];
    case 'union': return placeholder(name, def.options[0]);
    case 'array': return [placeholder(name.replace(/s$/, ''), def.element)];
    case 'object': return Object.fromEntries(Object.entries(def.shape).map(([key, value]) => [key, placeholder(key, value)]));
    case 'record': return {};
    default: return `{${name}}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const typeOf = (value: JsonSchema): string => value?.enum ? value.enum.map((item: unknown) => JSON.stringify(item)).join(' | ')
  : value?.anyOf ? value.anyOf.map(typeOf).join(' | ')
    : value?.type === 'array' ? `${typeOf(value.items)}[]`
      : Array.isArray(value?.type) ? value.type.join(' | ') : value?.type ?? 'any';

/** The schema of an object, looking through nullable and optional unions. */
function objectSchema(value: JsonSchema): JsonSchema | undefined {
  if (value?.properties) return value;
  return (value?.anyOf ?? []).find((option: JsonSchema) => option?.properties);
}

/**
 * Where each tool input travels in a recorded call. The REST body is not the
 * tool's input: a tool may turn an input into the path (`target` becomes
 * `/containers/{kind}/{id}/blocks`) or send an object's fields at the top
 * level of the body (`patch`). Each row names what REST takes, not the MCP
 * argument.
 */
function parameters(tool: ToolDef, args: Record<string, unknown>, omitted: ReadonlySet<string>, call: RestCall | undefined): RestParameter[] {
  if (!tool.inputSchema) return [];
  const json = z.toJSONSchema(z.object(tool.inputSchema as Record<string, ZodType>), { unrepresentable: 'any', io: 'input' }) as JsonSchema;
  const required = new Set<string>(json.required ?? []);
  const rows: RestParameter[] = [];
  for (const [name, value] of Object.entries(json.properties ?? {}) as [string, JsonSchema][]) {
    if (omitted.has(name)) continue;
    const given = args[name];
    const row = { name, type: typeOf(value), required: required.has(name), description: String(value?.description ?? '') };
    if (!call) { rows.push({ ...row, in: 'body' }); continue; }
    // In a variant chosen by its path (a page by page_id), the path parameter is required.
    if (call.path.includes(`{${name}}`)) { rows.push({ ...row, in: 'path', required: row.required || omitted.size > 0 }); continue; }
    if (call.query.includes(name)) { rows.push({ ...row, in: 'query' }); continue; }
    if (call.body.includes(name)) { rows.push({ ...row, in: 'body' }); continue; }
    const shape = objectSchema(value);
    if (shape && given && typeof given === 'object' && !Array.isArray(given)) {
      const fields = Object.entries(shape.properties) as [string, JsonSchema][];
      const inner = new Set<string>(shape.required ?? []);
      // An object whose placeholders make up the path: its fields are path parameters.
      const inPath = fields.filter(([key]) => {
        const leaf = (given as Record<string, unknown>)[key];
        return typeof leaf === 'string' && /^\{[^}]+\}$/.test(leaf) && call.path.includes(leaf);
      });
      if (inPath.length) {
        for (const [key, field] of inPath) rows.push({ name: key, in: 'path', type: typeOf(field), required: true, description: String(field?.description ?? row.description) });
        continue;
      }
      // An object sent field by field at the top level of the body.
      const keys = Object.keys(given);
      if (keys.length && keys.every(key => call.body.includes(key))) {
        for (const [key, field] of fields) rows.push({ name: key, in: 'body', type: typeOf(field), required: inner.has(key), description: String(field?.description ?? '') });
        if (shape.additionalProperties && typeof shape.additionalProperties === 'object' || shape.additionalProperties === true) {
          rows.push({ name: '…', in: 'body', type: 'any', required: false, description: `Other writable fields, also at the top level of the body. ${row.description}`.trim() });
        }
        continue;
      }
    }
    rows.push({ ...row, in: call.method === 'GET' || call.method === 'DELETE' ? 'query' : 'body' });
  }
  return rows;
}

async function record(tool: ToolDef, args: Record<string, unknown>): Promise<RestCall[]> {
  const calls: RestCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    // Only API calls are recorded; nothing leaves the process.
    if (url.origin !== BASE) return new Response('Not available while generating the reference', { status: 503 });
    let body: string[] = [];
    if (typeof init?.body === 'string') {
      try { const parsed = JSON.parse(init.body); body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []; } catch { body = []; }
    }
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: decodeURIComponent(url.pathname),
      query: [...new Set([...url.searchParams.keys()])],
      body,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new TyperollClient({ baseUrl: BASE, apiKey: 'typeroll_live_reference', fetchImpl });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A handler that polls stops being observed after its first calls.
    await Promise.race([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool.handler(args as any, { client, siteId: SITE }),
      new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
  } catch {
    // A handler may reject the empty recorded response after its call; the call is what matters.
  } finally {
    clearTimeout(timer);
    globalThis.fetch = realFetch;
  }
  return calls;
}

/**
 * The inputs each way of calling a tool is recorded with. A block tool that
 * takes a container `target` reaches a page by `page_id` and a partial or
 * PageTemplate by `target`, through different routes; both are recorded.
 */
function exampleArgs(tool: ToolDef): { args: Record<string, unknown>; omitted: Set<string> }[] {
  const example = EXAMPLE_ARGS[tool.name];
  if (example) return [{ args: example, omitted: new Set() }];
  const args: Record<string, unknown> = Object.fromEntries(Object.entries(tool.inputSchema ?? {}).map(([name, schema]) => [name, placeholder(name, schema)]));
  const target = args.target;
  if (!target || typeof target !== 'object' || !('kind' in target) || !('id' in target)) return [{ args, omitted: new Set() }];
  const container: Record<string, unknown> = { ...args, target: { kind: '{kind}', id: '{id}' } };
  delete container.page_id;
  const containerVariant = { args: container, omitted: new Set(['page_id']) };
  if (!('page_id' in args)) return [containerVariant];
  const page = { ...args };
  delete page.target;
  return [{ args: page, omitted: new Set(['target']) }, containerVariant];
}

export async function restReference(): Promise<RestEntry[]> {
  const entries: RestEntry[] = [];
  for (const tool of ALL_TOOLS) {
    if (LOCAL_TOOLS.has(tool.name)) continue;
    const variants: RestVariant[] = [];
    for (const { args, omitted } of exampleArgs(tool)) {
      const calls = await record(tool, args);
      variants.push({ calls, parameters: parameters(tool, args, omitted, calls[0]) });
    }
    const calls = variants.flatMap(variant => variant.calls);
    const note = variants.length > 1 && tool.inputSchema && 'target' in tool.inputSchema
      ? 'Over REST the container is part of the path: a page at the first address, a partial or PageTemplate (or a page) at the `containers` address. The MCP `target: { kind, id }` argument chooses that address; it is not a body key.'
      : undefined;
    entries.push({
      tool: tool.name, effect: effectFor(tool.name), description: tool.description,
      site: calls.some(call => call.path.startsWith(`/api/v1/sites/${SITE}/`)), calls, variants, ...(note ? { note } : {}),
    });
  }
  return entries;
}

const AREA_NAMES: Record<string, string> = {
  '': 'Site', access: 'Access', organizations: 'Organizations', sites: 'Sites', publishing: 'Organization publishing',
  organization: 'Organization', developer: 'Developer Extensions',
};

function area(entry: RestEntry): string {
  const path = entry.calls[0]?.path ?? '';
  const rest = entry.site ? path.slice(`/api/v1/sites/${SITE}/`.length) : path.replace(/^\/api\/(v1\/)?/, '');
  const segment = rest.split('/')[0] ?? '';
  const generic = segment.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
  const name = entry.site ? (segment ? generic : 'Details') : AREA_NAMES[segment] ?? generic;
  return entry.site ? `Site: ${name}` : name;
}

/** Markdown text outside code spans must not open HTML tags. */
const prose = (text: string) => text.split('`').map((part, index) => index % 2 ? part : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('`');
const cell = (text: string) => prose(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The published reference: one section per REST call behind each MCP tool. */
export function renderRestReference(entries: RestEntry[]): string {
  const groups = new Map<string, RestEntry[]>();
  for (const entry of entries) {
    const key = area(entry);
    groups.set(key, [...groups.get(key) ?? [], entry]);
  }
  const lines = [
    '---',
    'title: REST API reference',
    'description: Every operation the MCP server offers, as the REST call behind it. Generated from the MCP tools, so both always match.',
    '---',
    '',
    '<!-- Generated by `npm run gen:rest -w packages/mcp-server` from the MCP tool definitions. Do not edit by hand. -->',
    '',
    'Every MCP tool is a thin wrapper around one or more of these REST calls, so',
    'anything an AI agent can do through MCP, a script can do through the API. This',
    'page is generated from the tools and checked in CI, so it always matches them.',
    'For authentication, organizations and examples, see',
    '[Use the REST API](../../guides/rest-api/).',
    '',
    '- Base address: `https://app.typeroll.com` on Cloud, or your own portal host.',
    '- `{siteId}` and other names in braces are path parameters.',
    '- Send JSON bodies with `Content-Type: application/json`.',
    '- **Permission** is the least role or key permission the call needs: `read`, `write` or `admin`.',
    '- The MCP tool name is shown for each call, so agent instructions and scripts can use the same names.',
    '',
  ];
  for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${name}`, '');
    for (const entry of groups.get(name)!) {
      lines.push(`### \`${entry.tool}\``, '');
      for (const call of entry.calls) {
        lines.push(`\`${call.method} ${call.path}\``, '');
      }
      lines.push(`Permission: \`${entry.effect}\``, '', prose(entry.description.trim()), '');
      const tables = entry.variants.filter(variant => variant.parameters.length);
      if (entry.note) lines.push(prose(entry.note), '');
      for (const variant of tables) {
        if (tables.length > 1) lines.push(`Parameters of \`${variant.calls[0]!.method} ${variant.calls[0]!.path}\`:`, '');
        lines.push('| Parameter | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |');
        for (const parameter of variant.parameters) {
          lines.push(`| \`${parameter.name}\` | ${parameter.in} | ${cell(parameter.type)} | ${parameter.required ? 'yes' : 'no'} | ${cell(parameter.description)} |`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}
