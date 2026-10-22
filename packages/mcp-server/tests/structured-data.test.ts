// Structured-data builders (shared with the portal AI chat) and the MCP
// add_faq_schema / add_recipe_schema / add_event_schema tools.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { buildServer, type AllowedSite } from '../src/server.js';
import {
  buildEventJsonLd, buildFaqJsonLd, buildRecipeJsonLd, mergeJsonLd, StructuredDataError, structuredDataInputSchema,
} from '../src/structured-data.js';

function issues(fn: () => unknown): string[] {
  try { fn(); } catch (error) {
    if (error instanceof StructuredDataError) return error.issues;
    throw error;
  }
  throw new Error('expected a StructuredDataError');
}

describe('buildFaqJsonLd', () => {
  it('builds FAQPage with one Question per item, in order', () => {
    const { node, warnings } = buildFaqJsonLd({ items: [{ question: ' Do you ship? ', answer: 'Yes, within the EU.' }, { question: 'Returns?', answer: '30 days.' }] });
    expect(node).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Do you ship?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, within the EU.' } },
        { '@type': 'Question', name: 'Returns?', acceptedAnswer: { '@type': 'Answer', text: '30 days.' } },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it('refuses no items, empty answers and unknown item keys', () => {
    expect(issues(() => buildFaqJsonLd({ items: [] }))).toEqual(['items: Add at least one question.']);
    expect(issues(() => buildFaqJsonLd({ items: [{ question: 'Q', answer: '  ' }] }))).toEqual(['items.0.answer: Must not be empty.']);
    expect(issues(() => buildFaqJsonLd({ items: [{ question: 'Q', answer: 'A', url: 'x' }] }))[0]).toMatch(/^items\.0: Unrecognized key/);
  });
});

describe('buildRecipeJsonLd', () => {
  const base = { name: 'Cinnamon buns', ingredients: ['500 g flour', '2 tsp cinnamon'], instructions: ['Mix.', 'Bake at 225 °C.'] };

  it('maps fields to schema.org properties and numbers the steps', () => {
    const { node, warnings } = buildRecipeJsonLd({ ...base, description: 'Swedish classic', image_url: 'https://cdn.example.test/buns.jpg', author: 'Anna', prep_time: 'PT30M', cook_time: 'PT10M', total_time: 'PT1H40M', recipe_yield: '24 buns' });
    expect(node).toEqual({
      '@context': 'https://schema.org', '@type': 'Recipe', name: 'Cinnamon buns', description: 'Swedish classic',
      image: 'https://cdn.example.test/buns.jpg', author: { '@type': 'Person', name: 'Anna' },
      prepTime: 'PT30M', cookTime: 'PT10M', totalTime: 'PT1H40M', recipeYield: '24 buns',
      recipeIngredient: ['500 g flour', '2 tsp cinnamon'],
      recipeInstructions: [
        { '@type': 'HowToStep', position: 1, text: 'Mix.' },
        { '@type': 'HowToStep', position: 2, text: 'Bake at 225 °C.' },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it('warns without an image and refuses bad durations, URLs and empty lists', () => {
    expect(buildRecipeJsonLd(base).warnings[0]).toMatch(/image/);
    expect(issues(() => buildRecipeJsonLd({ ...base, prep_time: '30 minutes' }))).toEqual(['prep_time: Use an ISO 8601 duration such as PT30M or PT1H15M.']);
    expect(issues(() => buildRecipeJsonLd({ ...base, image_url: 'javascript:alert(1)' }))[0]).toMatch(/^image_url: /);
    expect(issues(() => buildRecipeJsonLd({ ...base, ingredients: [] }))).toEqual(['ingredients: Add at least one ingredient.']);
    expect(issues(() => buildRecipeJsonLd({ ingredients: ['x'], instructions: ['y'] }))[0]).toMatch(/^name: /);
  });
});

describe('buildEventJsonLd', () => {
  it('builds place and offer, normalizing price and currency', () => {
    const { node, warnings } = buildEventJsonLd({
      name: 'Summer concert', start_date: '2026-06-12T19:00:00+02:00', end_date: '2026-06-12T22:00:00+02:00',
      location_name: 'Town hall', location_address: 'Storgatan 1, Sundsvall', offers_url: 'https://tickets.example.test/s',
      offers_price: 250, offers_currency: 'sek',
    });
    expect(node).toEqual({
      '@context': 'https://schema.org', '@type': 'Event', name: 'Summer concert',
      startDate: '2026-06-12T19:00:00+02:00', endDate: '2026-06-12T22:00:00+02:00',
      location: { '@type': 'Place', name: 'Town hall', address: 'Storgatan 1, Sundsvall' },
      offers: { '@type': 'Offer', url: 'https://tickets.example.test/s', price: '250', priceCurrency: 'SEK', availability: 'https://schema.org/InStock' },
    });
    expect(warnings).toEqual([]);
  });

  it('warns about a missing UTC offset and location', () => {
    const { node, warnings } = buildEventJsonLd({ name: 'Open day', start_date: '2026-06-12T10:00' });
    expect(node).not.toHaveProperty('location');
    expect(node).not.toHaveProperty('offers');
    expect(warnings).toHaveLength(2);
  });

  it('refuses impossible dates, an end before the start and a price without currency', () => {
    expect(issues(() => buildEventJsonLd({ name: 'X', start_date: '2026-02-30' }))[0]).toMatch(/^start_date: /);
    expect(issues(() => buildEventJsonLd({ name: 'X', start_date: '12/06/2026' }))[0]).toMatch(/^start_date: /);
    expect(issues(() => buildEventJsonLd({ name: 'X', start_date: '2026-06-12', end_date: '2026-06-11' }))).toEqual(['end_date: Must not be before start_date.']);
    expect(issues(() => buildEventJsonLd({ name: 'X', start_date: '2026-06-12', offers_price: '10' }))).toEqual(['offers_currency: Required with offers_price.']);
    expect(issues(() => buildEventJsonLd({ name: 'X', start_date: '2026-06-12', offers_price: 'free', offers_currency: 'EUR' }))[0]).toMatch(/^offers_price: /);
  });
});

describe('mergeJsonLd', () => {
  const faq = buildFaqJsonLd({ items: [{ question: 'Q', answer: 'A' }] }).node;

  it('stores the node alone on an empty page', () => {
    expect(mergeJsonLd('', faq)).toEqual({ json_ld: JSON.stringify(faq), replaced: 0, kept: 0 });
    expect(mergeJsonLd(undefined, faq).kept).toBe(0);
  });

  it('replaces a node of the same type', () => {
    const old = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] });
    expect(mergeJsonLd(old, faq)).toEqual({ json_ld: JSON.stringify(faq), replaced: 1, kept: 0 });
  });

  it('keeps other nodes in an @graph and replaces same-type nodes inside one', () => {
    const business = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Acme' };
    const once = mergeJsonLd(JSON.stringify(business), faq);
    expect(once.kept).toBe(1);
    expect(JSON.parse(once.json_ld)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'LocalBusiness', name: 'Acme' }, { '@type': 'FAQPage', mainEntity: faq.mainEntity }],
    });
    const again = mergeJsonLd(once.json_ld, faq);
    expect(again).toMatchObject({ replaced: 1, kept: 1 });
    expect(JSON.parse(again.json_ld)['@graph']).toHaveLength(2);
  });

  it('refuses an existing value that is not JSON-LD rather than overwriting it', () => {
    expect(issues(() => mergeJsonLd('{not json', faq))[0]).toMatch(/not valid JSON/);
    expect(issues(() => mergeJsonLd('"text"', faq))[0]).toMatch(/not a JSON-LD object/);
  });
});

interface Recorded { method: string; url: string; body: unknown }

async function session(existingJsonLd: string | null, allowedSites: AllowedSite[] = [{ siteId: 'site', permission: 'write' }]) {
  const calls: Recorded[] = [];
  const api = new TyperollClient({
    baseUrl: 'https://example.test', apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url).replace('https://example.test/api/v1/', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json((init?.method ?? 'GET') === 'GET' ? { page: { id: 'faq', json_ld: existingJsonLd } } : { page: { id: 'faq' } });
    },
  });
  const server = buildServer({ client: api, allowedSites });
  const client = new Client({ name: 'structured-data', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { site_id: 'site', ...args } });
    return { isError: result.isError, data: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
  };
  return { client, calls, call, close: async () => { await client.close(); await server.close(); } };
}

describe('structured-data MCP tools', () => {
  it('are listed with the chat tool names and their inputs', async () => {
    const s = await session(null);
    try {
      const { tools } = await s.client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName.get('add_faq_schema')!.inputSchema.properties!)).toEqual(expect.arrayContaining(['page_id', 'items', 'save', 'version']));
      expect(byName.get('add_recipe_schema')!.inputSchema.required).toEqual(expect.arrayContaining(['page_id', 'name', 'ingredients', 'instructions']));
      expect(byName.get('add_event_schema')!.inputSchema.required).toEqual(expect.arrayContaining(['page_id', 'name', 'start_date']));
    } finally { await s.close(); }
  });

  it('reads the draft view, merges and writes json_ld on the requested version', async () => {
    const s = await session(JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme' }));
    try {
      const result = await s.call('add_faq_schema', { page_id: 'faq', items: [{ question: 'Q', answer: 'A' }], version: 'draft-branch', save: true });
      expect(result.isError).not.toBe(true);
      expect(result.data).toMatchObject({ ok: true, schema_type: 'FAQPage', replaced_same_type: 0, kept_other_nodes: 1, saved: true, warnings: [] });
      expect(s.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET sites/site/pages/faq?version=draft-branch',
        'PATCH sites/site/pages/faq?version=draft-branch',
      ]);
      const body = s.calls[1]!.body as { json_ld: string; save: boolean };
      expect(body.save).toBe(true);
      expect(JSON.parse(body.json_ld)['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(['Organization', 'FAQPage']);
    } finally { await s.close(); }
  });

  it('returns validation issues and writes nothing for invalid input', async () => {
    const s = await session(null);
    try {
      const result = await s.call('add_event_schema', { page_id: 'e', name: 'X', start_date: '2026-06-12', end_date: '2026-06-01' });
      expect(result.isError).toBe(true);
      expect(result.data.issues).toEqual(['end_date: Must not be before start_date.']);
      expect(s.calls).toEqual([]);
    } finally { await s.close(); }
  });

  it('refuses to overwrite an existing json_ld that is not valid JSON', async () => {
    const s = await session('{broken');
    try {
      const result = await s.call('add_recipe_schema', { page_id: 'r', name: 'Buns', ingredients: ['flour'], instructions: ['bake'] });
      expect(result.isError).toBe(true);
      expect(s.calls.map((c) => c.method)).toEqual(['GET']);
    } finally { await s.close(); }
  });

  it('need write permission on a multi-site connection', async () => {
    const s = await session(null, [{ siteId: 'site', permission: 'read' }]);
    try {
      const result = await s.client.callTool({ name: 'add_faq_schema', arguments: { site_id: 'site', page_id: 'faq', items: [{ question: 'Q', answer: 'A' }] } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('requires write permission');
      expect(s.calls).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('structuredDataInputSchema', () => {
  it('describes the same inputs as the MCP tools, plus page_id, for the portal chat', () => {
    const event = structuredDataInputSchema('event');
    expect(event.type).toBe('object');
    expect(event).not.toHaveProperty('$schema');
    expect(event.required).toEqual(['page_id', 'name', 'start_date']);
    expect(Object.keys(event.properties)).toEqual(['page_id', 'name', 'description', 'start_date', 'end_date', 'location_name', 'location_address', 'image_url', 'offers_url', 'offers_price', 'offers_currency']);
    expect(structuredDataInputSchema('faq').required).toEqual(['page_id', 'items']);
  });
});
