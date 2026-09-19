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
import { doctor, readWorkspace, workspaceClient, verifyWorkspaceBinding } from './workspace.js';

function bail(message: string): never {
  console.error(`typeroll-mcp: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'doctor') {
    const args = argv.slice(1);
    if (args.includes('--help')) { console.log('Usage: typeroll doctor [directory] [--offline] [--json]'); return; }
    if (args.some(arg => arg.startsWith('-') && !['--offline', '--json'].includes(arg)) || args.filter(arg => !arg.startsWith('-')).length > 1) bail('Usage: doctor [directory] [--offline] [--json]');
    const result = await doctor(args.find(arg => !arg.startsWith('-')) ?? '.', args.includes('--offline'));
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : result.checks.map(check => `${check.status}: ${check.check} — ${check.message}`).join('\n'));
    process.exitCode = result.passed ? 0 : 1; return;
  }
  if (argv[0] === 'workspace-mcp') {
    if (argv.length > 2) bail('Usage: workspace-mcp [directory]');
    const config = await readWorkspace(argv[1] ?? '.');
    const client = workspaceClient(config, process.env);
    if (config.site_id) await verifyWorkspaceBinding(config, client);
    // An unbound workspace permits discovery/site creation only. Save the Site
    // binding and reconnect before content operations; never guess a target.
    const server = buildServer({ client, ...(config.site_id ? { fixedSiteId: config.site_id } : { allowedSites: [] }), toolMode: config.tool_mode, info: { name: 'typeroll', version: VERSION } });
    await server.connect(new StdioServerTransport()); return;
  }
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
    console.error('  typeroll-mcp init [dir] [--update]              Create/update an agent-neutral workspace (see init --help)');
    console.error('  typeroll-mcp install-skills <dir> [-f]    Copy bundled skill files to <dir>');
    console.error('  typeroll-mcp doctor [dir] [--offline]     Read-only workspace/connection checks');
    console.error('  typeroll-mcp workspace-mcp [dir]          MCP bound to typeroll.json (compact by default)');
    console.error('  typeroll extension <command>              Validate, push, install, configure or promote an Extension');
    console.error('  typeroll-mcp --help                       Show this help');
    process.exit(0);
  }

  if (argv.length) bail('Unknown command. Use --help.');
  const mode = process.env.TYPEROLL_MCP_TOOL_MODE ?? 'full';
  if (!['full', 'compact'].includes(mode)) bail('TYPEROLL_MCP_TOOL_MODE must be full or compact.');
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
    toolMode: mode as 'full' | 'compact',
    info: { name: 'typeroll', version: VERSION },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('typeroll-mcp fatal:', err);
  process.exit(1);
});
