import { promises as fs } from 'node:fs';
import path from 'node:path';
import { skillsDir } from './install-skills.js';
import { VERSION } from './version.js';
import { defaultWorkspace, workspaceTemplates, writeWorkspaceFiles } from './workspace.js';

export interface InitOptions { dir: string; update?: boolean; recipes?: boolean; client?: 'none' | 'claude' | 'cursor' | 'vscode'; sourceDir?: string }
export async function runInit(options: InitOptions) {
  const dir = path.resolve(options.dir);
  const templates: Record<string, string> = { ...workspaceTemplates, 'typeroll.json': JSON.stringify(defaultWorkspace, null, 2) + '\n' };
  if (options.recipes) {
    const source = options.sourceDir ?? skillsDir();
    for (const file of (await fs.readdir(source)).filter(file => /^tr-[a-z0-9-]+\.md$/.test(file))) templates[`typeroll-skills/${file}`] = await fs.readFile(path.join(source, file), 'utf8');
  }
  const client = options.client ?? 'none';
  if (client !== 'none') {
    const entry = { command: 'npx', args: ['-y', `@typeroll/mcp-server@${VERSION}`, 'workspace-mcp', dir] };
    const file = client === 'claude' ? '.mcp.json' : client === 'cursor' ? '.cursor/mcp.json' : '.vscode/mcp.json';
    // The hash-based updater replaces only an unchanged generated file. It never
    // merges a user-owned configuration, credentials or another server entry.
    templates[file] = JSON.stringify(client === 'vscode' ? { servers: { typeroll: { type: 'stdio', ...entry } } } : { mcpServers: { typeroll: entry } }, null, 2) + '\n';
  }
  const files = await writeWorkspaceFiles(dir, templates, options.update ?? false);
  return { dir, generator_version: VERSION, files, client, recipes: options.recipes ?? false };
}
export async function runInitCli(args: string[]): Promise<number> {
  let dir = '.', update = false, recipes = false, client: InitOptions['client'] = 'none', hadDir = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') { console.log('Usage: typeroll init [directory] [--update] [--recipes] [--client none|claude|cursor|vscode]\nCreates an agent-neutral workspace. No network calls or remote writes. Updates preserve edited files.'); return 0; }
    if (arg === '--update') update = true;
    else if (arg === '--recipes') recipes = true;
    else if (arg === '--client' && ['none', 'claude', 'cursor', 'vscode'].includes(args[index + 1] ?? '')) client = args[++index] as InitOptions['client'];
    else if (!arg.startsWith('-') && !hadDir) { dir = arg; hadDir = true; }
    else { console.error(`Unsupported init argument: ${arg}. Use --help. --force is not supported; reconcile edited files explicitly.`); return 1; }
  }
  try {
    const result = await runInit({ dir, update, recipes, client });
    console.log(JSON.stringify(result, null, 2));
    console.log('Next: fill brief/, connect hosted MCP at https://app.typeroll.com/api/mcp?tools=compact, create/select your Site, record its IDs/Version in typeroll.json, then run typeroll doctor. Local MCP uses an injected TYPEROLL_API_KEY; no key is stored by init. See README.md.');
    return 0;
  } catch { console.error('Workspace could not be created/updated. Check file permissions, symlinks and typeroll.lock.json. Existing edited files are not overwritten.'); return 1; }
}
