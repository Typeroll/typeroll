// The built-in AI assistant has no migration capability. Migrations are done
// with the user's own agent (Claude Code, Codex or another MCP client) through
// MCP and the public API, where the migration tools stay available.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildChatSystemPrompt, chatToolNames } from '../../lib/anthropic';

describe('built-in assistant and migrations', () => {
  it('offers no migration, import, inventory, workflow or launch-report tools', () => {
    const names = chatToolNames();
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(name).not.toMatch(/migrat|import|inventory|parity|launch|workflow|sitemap|wordpress|wp_/i);
    }
  });

  it('tells the model to send migrations to the user’s own agent over MCP', () => {
    const prompt = buildChatSystemPrompt('Example', null);
    expect(prompt).toContain('You do not migrate or import sites');
    expect(prompt).toContain('Claude Code, Codex or another MCP client');
  });

  it('has no server-side AI reconstruction in the WordPress import', () => {
    expect(existsSync(fileURLToPath(new URL('../../lib/wp/ai-reconstruct.ts', import.meta.url)))).toBe(false);
  });
});
