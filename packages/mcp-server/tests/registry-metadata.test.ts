// The MCP Registry lists this server from server.json. Its name must match
// package.json's mcpName (the registry checks the published npm package), and
// its versions must be the version being published.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const server = read('server.json');
const pkg = read('package.json');

describe('MCP Registry metadata', () => {
  it('names the published npm package and its version', () => {
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(server.name).toBe(pkg.mcpName);
    // GitHub OIDC grants io.github.<repository owner>/*, compared case-sensitively.
    expect(server.name).toMatch(/^io\.github\.Typeroll\/[a-z0-9._-]+$/);
    expect(server.version).toBe(pkg.version);
    expect(server.version).toBe(VERSION);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } });
  });

  it('declares the stdio environment and the hosted Cloud endpoint', () => {
    const env = Object.fromEntries(server.packages[0].environmentVariables.map((input: { name: string }) => [input.name, input]));
    expect(env.TYPEROLL_API_KEY).toMatchObject({ isRequired: true, isSecret: true });
    expect(env.TYPEROLL_API_URL.default).toBe('https://app.typeroll.com');
    expect(server.remotes).toEqual([{ type: 'streamable-http', url: 'https://app.typeroll.com/api/mcp' }]);
  });
});
