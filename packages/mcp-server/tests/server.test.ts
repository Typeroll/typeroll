// Regression guard for the delivery of server-level instructions.
//
// The MCP `instructions` string is the one channel that reaches EVERY
// consumer automatically (Claude Code stdio + the hosted connector) at
// connect time. If buildServer stops setting it, agents silently lose the
// operating manual — so we assert it's wired and carries the key directives.

import { describe, it, expect } from 'vitest';
import { buildServer, SERVER_INSTRUCTIONS } from '../src/server.js';
import { TyperollClient } from '../src/client.js';

const client = new TyperollClient({ baseUrl: 'https://unused.test', apiKey: 'typeroll_live_x_y' });

function instructionsOf(server: unknown): string | undefined {
  // McpServer.server is public; _instructions is private — reach it for the
  // assertion (this is a regression guard, not production code).
  const inner = (server as { server?: unknown }).server as { _instructions?: string } | undefined;
  return inner?._instructions;
}

describe('server instructions delivery', () => {
  it('buildServer attaches the operating manual (single-site)', () => {
    const server = buildServer({ client, fixedSiteId: 'site1' });
    expect(instructionsOf(server)).toBe(SERVER_INSTRUCTIONS);
  });

  it('buildServer attaches it in multi-site mode too', () => {
    const server = buildServer({
      client,
      allowedSites: [{ siteId: 'a', permission: 'admin' }],
    });
    expect(instructionsOf(server)).toBe(SERVER_INSTRUCTIONS);
  });

  it('the manual points agents at the key runtime entry points', () => {
    // These are the directives that make the rest of the surface discoverable;
    // keep them present so the delivery stays meaningful.
    expect(SERVER_INSTRUCTIONS).toMatch(/list_skills/);
    expect(SERVER_INSTRUCTIONS).toMatch(/create_branch/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Discover before you write/i);
  });
});
