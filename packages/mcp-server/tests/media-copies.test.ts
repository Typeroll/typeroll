// Moveria (Core 0.3.29): delete_media said "R2 object cleanup is a separate
// ops task", and nothing removed published copies of deleted photos. These pin
// the tool that removes them and its admin classification.
import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { mediaTools } from '../src/tools/media.js';
import { effectFor } from '../src/server.js';

function setup(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const client = new TyperollClient({
    baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb',
    fetchImpl: async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input instanceof Request ? input.url : input), body: typeof init?.body === 'string' ? init.body : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, siteId: 'mysite', calls };
}
const tool = (name: string) => mediaTools.find(candidate => candidate.name === name)!;

describe('published media copies', () => {
  it('remove_published_media_copies posts ids, urls and dry_run to the site route', async () => {
    const { client, siteId, calls } = setup();
    const args = { media_ids: ['f9fb91f4-1ba8-48de-97ad-b0be86d76d7e'], urls: ['https://media.example.test/media/abc/0123456789abcdef-a.jpg'], dry_run: true };
    await tool('remove_published_media_copies').handler(args as never, { client, siteId });
    expect(calls).toEqual([{ method: 'POST', url: 'https://example.test/api/v1/sites/mysite/media/published-copies', body: JSON.stringify(args) }]);
  });

  it('treats a 207 (purge unavailable, something left) as a result the agent can act on', async () => {
    const { client, siteId } = setup(207, { public_copies: { removed: ['media/abc/x.jpg'], purge_unavailable: [{ host: 'media.example.test', code: 'cache_purge_permission_required' }] } });
    const result = await tool('remove_published_media_copies').handler({ urls: ['https://media.example.test/media/abc/x.jpg'] } as never, { client, siteId });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('cache_purge_permission_required');
  });

  it('is an admin tool, and delete_media no longer calls copy cleanup a separate task', () => {
    expect(effectFor('remove_published_media_copies')).toBe('admin');
    expect(effectFor('delete_media')).toBe('write');
    expect(tool('delete_media').description).not.toContain('separate ops task');
    expect(tool('delete_media').description).toContain('purge_unavailable');
  });
});
