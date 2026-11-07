// Snippet tools: each maps onto /api/v1/sites/{siteId}/snippets, takes no
// version (snippets belong to the site), and refused saves report their
// paths plainly.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { snippetTools } from '../src/tools/snippets.js';
import { effectFor } from '../src/server.js';

interface Recorded { method: string; url: string; body: unknown }

function setup(responder: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    return responder(call);
  };
  return { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite', calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tool = (name: string) => snippetTools.find(t => t.name === name)!;
const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
const URL_ = 'https://example.test/api/v1/sites/mysite/snippets';

describe('snippet tools', () => {
  it('classifies reads and writes', () => {
    expect(['list_snippets', 'read_snippet', 'update_snippet', 'delete_snippet'].map(effectFor)).toEqual(['read', 'read', 'write', 'write']);
  });

  it('lists, reads, replaces and deletes with the revision check', async () => {
    const { client, siteId, calls } = setup(() => json({ ok: true }));
    await tool('list_snippets').handler({} as never, { client, siteId });
    await tool('read_snippet').handler({ snippet_id: 'lunch' } as never, { client, siteId });
    const entries = [{ weekday: 'monday', content: '<p>Soup</p>' }];
    await tool('update_snippet').handler({ snippet_id: 'lunch', name: 'Lunch', kind: 'dated', entries, expected_updated_at: 'T1' } as never, { client, siteId });
    await tool('delete_snippet').handler({ snippet_id: 'lunch', expected_updated_at: 'T2' } as never, { client, siteId });
    expect(calls).toEqual([
      { method: 'GET', url: URL_, body: null },
      { method: 'GET', url: `${URL_}/lunch`, body: null },
      { method: 'PUT', url: `${URL_}/lunch`, body: { name: 'Lunch', kind: 'dated', entries, expected_updated_at: 'T1' } },
      { method: 'DELETE', url: `${URL_}/lunch?expected_updated_at=T2`, body: null },
    ]);
  });

  it('reports validation errors with their paths and explains a conflict', async () => {
    const invalid = setup(() => json({ error: 'not valid', details: { errors: [{ path: 'entries[0].weekday', message: 'One of monday…' }] } }, 400));
    const out = await tool('update_snippet').handler({ snippet_id: 'lunch', name: 'Lunch', kind: 'dated', entries: [] } as never, { client: invalid.client, siteId: 'mysite' });
    expect(out.isError).toBe(true);
    expect(text(out as never)).toMatchObject({ status: 400, errors: [{ path: 'entries[0].weekday' }] });
    const stale = setup(() => json({ error: 'saved by someone else' }, 409));
    const conflict = await tool('update_snippet').handler({ snippet_id: 'lunch', name: 'Lunch', kind: 'text', content: 'x', expected_updated_at: 'old' } as never, { client: stale.client, siteId: 'mysite' });
    expect(text(conflict as never).hint).toContain('read_snippet');
  });

  it('teaches what a snippet is and how to place it', () => {
    const description = tool('list_snippets').description;
    for (const needle of ['without a publication', 'dated', 'weekday', 'fallback', 'core/snippet', 'live: true', 'core/site_field', 'once'])
      expect(description).toContain(needle);
  });
});
