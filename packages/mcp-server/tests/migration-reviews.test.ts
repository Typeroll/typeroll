import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { migrationTools } from '../src/tools/migration.js';
import { readBundledSkill } from '../src/tools/skills.js';

const tool = migrationTools.find(tool => tool.name === 'get_migration_readiness')!;
const schema = z.object(tool.inputSchema!);
describe('reviewed migration composition contract', () => {
  it('forwards reviewed choices without substituting the block tree', async () => {
    const composition = {
      name: 'Hero', blocks: [{ id: 'hero', type: 'layered_hero', data: { title: 'Hello' } }],
      reviewed_custom_block_types: [{ type: 'layered_hero', reason: 'Editable layered artwork.' }],
      reviewed_html_blocks: [{ block_id: 'unique-artwork', reason: 'Documented one-off exception.' }],
    };
    const args = schema.parse({ compositions: [composition] });
    const post = vi.fn().mockResolvedValue({ ready: true });
    await tool.handler(args, { client: { post }, siteId: 'selected' } as never);
    expect(post).toHaveBeenCalledWith('selected', 'migration-preflight', { compositions: [composition] });
  });
  it.each(['', ' ', 'x'.repeat(2001)])('rejects an invalid rationale', reason => {
    expect(schema.safeParse({ compositions: [{ name: 'Hero', blocks: [], reviewed_html_blocks: [{ block_id: 'hero', reason }] }] }).success).toBe(false);
  });
  it('distributes both intents and hero exceptions through the hosted skill reader', () => {
    const skill = readBundledSkill('tr-migration-evidence');
    for (const phrase of ['preserve', 'renew', 'reviewed_custom_block_types', 'reviewed_html_blocks', 'art-directed hero', 'Old URLs must continue to work']) expect(skill).toContain(phrase);
  });
});
