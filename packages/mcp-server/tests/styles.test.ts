// Style tools forward the style as given: the new props (opacity, shadow,
// gap), the link and image targets and the site-wide block `parts`.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TyperollClient } from '../src/client.js';
import { styleTools } from '../src/tools/styles.js';

interface Recorded { method: string; url: string; body: unknown }

function setup() {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { deps: { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite' }, calls };
}

const tool = (name: string) => styleTools.find(candidate => candidate.name === name)!;
const BASE = 'https://example.test/api/v1/sites/mysite';

describe('style tools', () => {
  const style = {
    id: 'quiet-link', name: 'Quiet link', targets: ['link'],
    base: { decoration: 'none', opacity: 0.8, shadow: 'none', gap: '0.5rem 1rem' },
    parts: ['core/rich_heading.link'],
  };

  it('create_style accepts the new props, targets and parts and forwards them', async () => {
    const parsed = z.object(tool('create_style').inputSchema as z.ZodRawShape).parse(style);
    expect(parsed).toEqual(style);
    const { deps, calls } = setup();
    await tool('create_style').handler(parsed as never, deps);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/styles`, body: style });
  });

  it('refuses an unknown shadow preset or opacity outside 0..1', () => {
    const schema = z.object(tool('create_style').inputSchema as z.ZodRawShape);
    expect(schema.safeParse({ ...style, base: { shadow: 'xl' } }).success).toBe(false);
    expect(schema.safeParse({ ...style, base: { opacity: 2 } }).success).toBe(false);
    expect(schema.safeParse({ ...style, targets: ['image'] }).success).toBe(true);
  });

  it('update_style forwards parts', async () => {
    const parsed = z.object(tool('update_style').inputSchema as z.ZodRawShape).parse({ style_id: 'quiet-link', parts: [] });
    const { deps, calls } = setup();
    await tool('update_style').handler(parsed as never, deps);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/styles/quiet-link`, body: { parts: [] } });
  });

  it('describes site-wide part styles and their precedence', () => {
    const parts = (tool('create_style').inputSchema as Record<string, z.ZodTypeAny>).parts!.description ?? '';
    for (const needle of ['core/rich_heading.link', 'read_block_type', 'part_styles', 'eyebrow_style_id']) expect(parts).toContain(needle);
    expect(tool('create_style').description).toContain('part_styles');
  });
});
