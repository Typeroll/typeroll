#!/usr/bin/env node
// Typeroll MCP server — stdio entry point.
//
// Reads two env vars at startup:
//   TYPEROLL_API_URL  — base URL of the portal (e.g. https://app.typeroll.com)
//   TYPEROLL_API_KEY  — a typeroll_live_... bearer token from the portal
//
// Optionally:
//   TYPEROLL_SITE_ID  — pre-set the site id. If omitted we discover it by
//                   calling GET /v1/sites at startup. For site-scoped keys
//                   that endpoint always returns exactly one. For org-scoped
//                   keys (introduced for the hosted MCP connector) it can
//                   return many — in that case TYPEROLL_SITE_ID is required
//                   so this stdio invocation maps onto one specific site.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TyperollClient } from './client.js';
import { runInitCli } from './init.js';
import { runInstallSkillsCli } from './install-skills.js';
import { resolveSiteId } from './resolve-site-id.js';
import { buildServer } from './server.js';
import { VERSION } from './version.js';
import { runExtensionCli } from './extension-cli.js';

function bail(message: string): never {
  console.error(`typeroll-mcp: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') {
    const code = await runInitCli(argv.slice(1));
    process.exit(code);
  }
  if (argv[0] === 'install-skills') {
    const code = await runInstallSkillsCli(argv.slice(1));
    process.exit(code);
  }
  if (argv[0] === 'extension') {
    const code = await runExtensionCli(argv.slice(1));
    process.exit(code);
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.error('Usage:');
    console.error('  typeroll-mcp                              Start the MCP server (reads TYPEROLL_API_URL and TYPEROLL_API_KEY)');
    console.error('  typeroll-mcp init [dir] [-f]              Bootstrap a project: skills + .mcp.json + AGENTS.md + imagegen lab');
    console.error('  typeroll-mcp install-skills <dir> [-f]    Copy bundled skill files to <dir>');
    console.error('  typeroll extension <command>              Validate, push, install, configure or promote an Extension');
    console.error('  typeroll-mcp --help                       Show this help');
    process.exit(0);
  }

  const apiUrl = process.env.TYPEROLL_API_URL?.trim();
  const apiKey = process.env.TYPEROLL_API_KEY?.trim();
  if (!apiUrl) bail('TYPEROLL_API_URL is not set. Point it at your Typeroll portal (e.g. https://app.typeroll.com).');
  if (!apiKey) bail('TYPEROLL_API_KEY is not set. Create a key in /app/sites/{siteId}/settings/api-keys and copy it once.');
  if (!apiKey.startsWith('typeroll_live_')) {
    bail('TYPEROLL_API_KEY does not look like a Typeroll key (expected typeroll_live_... prefix).');
  }

  const client = new TyperollClient({ baseUrl: apiUrl, apiKey });

  let siteId: string;
  try {
    siteId = await resolveSiteId(client);
  } catch (e) {
    bail(`Failed to discover site: ${e instanceof Error ? e.message : String(e)}`);
  }

  const server = buildServer({
    client,
    fixedSiteId: siteId,
    info: { name: 'typeroll', version: VERSION },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('typeroll-mcp fatal:', err);
  process.exit(1);
});
