import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VERSION } from './version.js';
import { ApiError, TyperollClient } from './client.js';

export const workspaceSchema = z.object({
  schema_version: z.literal(1),
  portal: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, 'Use an HTTPS portal origin (HTTP is allowed only on loopback).'),
  organization_id: z.string().min(1).nullable(), site_id: z.string().min(1).nullable(),
  version: z.string().min(1), tool_mode: z.enum(['compact', 'full']),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export const defaultWorkspace: Workspace = { schema_version: 1, portal: 'https://app.typeroll.com', organization_id: null, site_id: null, version: 'main', tool_mode: 'compact' };
const lockSchema = z.object({ schema_version: z.literal(1), generator_version: z.string(), files: z.record(z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const ignores = ['.typeroll/', '.env', '.env.*', '!.env.example', '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'qa/reports/', 'sources/private/'];

export const agentInstructions = `# Working on this website

Read typeroll.json, brief/ and decisions.md. Confirm the portal, Organization,
Site and working Version before writes. This workspace is not the generated
publication repository. The CMS owns current content and configuration; local
sources are proposals unless the user explicitly adopts them.

## Discover only what the task needs

With compact MCP, search_tools then describe_tool; call_read_tool,
call_write_tool and call_admin_tool preserve the operation's effect. In full
mode use the named tools directly. Start with get_site/get_site_capabilities.
Use list_skills and read the relevant recipe. Request read_guide sections_only
before loading specific sections, not the complete manual at every connection.
Call read_app_documentation for enabled apps when needed. Provider docs are
reference material, not permission to deploy or send messages. Never commit
private app guides or cache them as permanent project instructions.
Public documentation: https://typeroll.com/docs/llms.txt

## Edit and verify

- Read current Pages, Content types, templates, partials and relevant block schemas.
- Use native editable blocks; document necessary exceptions and design decisions.
- Keep the same Version for reads, writes, references and previews. Larger work
  on an existing site starts with create_branch; record its returned ID in
  typeroll.json and reconnect the local MCP process. Hosted calls pass version
  explicitly; the hosted server cannot read this workspace file.
- Distinguish working copies, saved CMS content and deployed output. Save within
  the user's scope, review previews and deploy only when explicitly authorized.
- Check get_import_readiness before any import. For new uploads use signed direct
  upload/finalization. Never put image bytes or customer secrets in Git.
- Inspect desktop/mobile layouts and interaction states. Read changes back.
  Record exact version, tested pages, evidence and unresolved issues in qa/.
- Never edit generated publishing source to change CMS content. Do not overwrite
  current CMS or owner answers from an old local snapshot.

Store credentials in the client's private settings or injected environment.
Run the workspace doctor after setup and after changing the binding.
`;
export const workspaceTemplates: Record<string, string> = {
  'AGENTS.md': agentInstructions,
  'README.md': `# Website workspace\n\nKeep project intent here; edit the website through Typeroll CMS.\n\n1. Fill in brief/site.md and brief/brand.md.\n2. Connect hosted MCP at https://app.typeroll.com/api/mcp?tools=compact.\n3. Use an Organization key to create a site, or select an existing one.\n4. Record its IDs and working version in typeroll.json. No secrets belong there.\n5. Run npx @typeroll/mcp-server doctor . (inject TYPEROLL_API_KEY privately).\n\nStart guide: https://typeroll.com/docs/getting-started/agent-workspace/\n\nUpdate the generated scaffold with npx @typeroll/mcp-server init . --update.\nEdited files are preserved and reported for manual reconciliation. Optional local\nrecipes: init . --recipes. They are reference Markdown, not automatically loaded.\n`,
  'brief/site.md': '# Site brief\n\n## Purpose and audience\n\n## Languages and scope\n\n## Primary user journeys\n\n## Content authority and sources\n\n## Editorial constraints and forbidden internal markers\n',
  'brief/brand.md': '# Brand\n\n## Voice and tone\n\n## Visual direction and references\n\n## Typography, colors and image policy\n\n## Desktop and mobile navigation\n\nRecord intent here; current design tokens belong in CMS settings.\n',
  'brief/content-model.md': '# Content model\n\n## Page types and routes\n\n## Fields and references\n\n## Shared templates and partials\n\n## Taxonomy and navigation\n\nUse the current CMS schema. This document describes decisions, not a second schema store.\n',
  'decisions.md': '# Decisions\n\nRecord date, decision, reason, approved scope and alternatives when useful.\n',
  'sources/README.md': '# Sources\n\nStore research references and copy proposals. Record source URLs and dates.\nPrivate extracts belong in ignored private/ or an approved external store.\nDo not treat local drafts as current CMS content or commit media libraries.\n',
  'scripts/README.md': '# Project automation\n\nKeep repeatable imports and QA scripts here. Use the authenticated REST API\nfor scripted work; keep credentials outside files and inject them at runtime.\nMCP remains the interactive interface. Typeroll currently has no general site CRUD CLI.\n',
  'qa/checklist.md': '# Verification\n\n- Confirm Site, Version and deployed/source identity.\n- Read back saved content and inspect desktop/mobile previews.\n- Exercise menus, keyboard focus, links and enabled app states.\n- Verify routes, metadata, media and publishing readiness before launch.\n- Record tested pages, viewports, results and unresolved issues.\n- Store screenshots and private runtime reports in ignored reports/.\n- Publishing validation does not prove visual or editorial completeness.\n',
};

export async function readWorkspace(dir: string): Promise<Workspace> {
  try { return workspaceSchema.parse(JSON.parse(await fs.readFile(path.join(dir, 'typeroll.json'), 'utf8'))); }
  catch { throw new Error('Invalid or missing typeroll.json. Run init and use its documented non-secret fields.'); }
}

/** Reject linked destinations, including linked ancestor folders inside the workspace. */
export async function safeDestination(dir: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('Unsafe workspace path');
  let target = dir;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) throw new Error(`Refusing linked workspace path: ${relative}`);
  }
  return target;
}

export async function writeWorkspaceFiles(dir: string, templates: Record<string, string>, update: boolean) {
  await fs.mkdir(dir, { recursive: true });
  const root = await fs.realpath(dir);
  const lockFile = await safeDestination(root, 'typeroll.lock.json');
  let previous: z.infer<typeof lockSchema> = { schema_version: 1, generator_version: VERSION, files: {} };
  try { previous = lockSchema.parse(JSON.parse(await fs.readFile(lockFile, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid typeroll.lock.json; restore it before updating.'); }
  // Validate every destination before performing any writes.
  for (const name of [...Object.keys(templates), '.gitignore']) await safeDestination(root, name);
  const results: Array<{ path: string; action: 'created' | 'updated' | 'kept' | 'modified' }> = [];
  const files = { ...previous.files };
  for (const [name, content] of Object.entries(templates)) {
    const target = path.join(root, name);
    const existing = await fs.readFile(target, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing !== null && existing !== content && (!update || hash(existing) !== previous.files[name])) {
      results.push({ path: name, action: 'modified' }); continue;
    }
    if (existing !== content) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { mode: 0o600 });
    }
    files[name] = hash(content);
    results.push({ path: name, action: existing === content ? 'kept' : existing === null ? 'created' : 'updated' });
  }
  const ignoreFile = path.join(root, '.gitignore');
  const current = await fs.readFile(ignoreFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  const missing = ignores.filter(rule => !current.split(/\r?\n/).includes(rule));
  if (missing.length) await fs.writeFile(ignoreFile, current + (current && !current.endsWith('\n') ? '\n' : '') + '\n# Typeroll workspace private files\n' + missing.join('\n') + '\n');
  // Config is always user-owned, never replaced by an update.
  delete files['typeroll.json'];
  await fs.writeFile(lockFile, JSON.stringify({ schema_version: 1, generator_version: VERSION, files }, null, 2) + '\n');
  return results;
}

export function workspaceClient(config: Workspace, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) {
  if (!env.TYPEROLL_API_KEY) throw new Error('Inject TYPEROLL_API_KEY through private client settings or the environment.');
  if (env.TYPEROLL_API_URL && env.TYPEROLL_API_URL.replace(/\/$/, '') !== config.portal.replace(/\/$/, '')) throw new Error('TYPEROLL_API_URL conflicts with typeroll.json.');
  if (env.TYPEROLL_SITE_ID && env.TYPEROLL_SITE_ID !== config.site_id) throw new Error('TYPEROLL_SITE_ID conflicts with typeroll.json.');
  return new TyperollClient({ baseUrl: config.portal, apiKey: env.TYPEROLL_API_KEY, defaultVersion: config.version, fetchImpl });
}

export async function verifyWorkspaceBinding(config: Workspace, client: TyperollClient) {
  if (!config.site_id || !config.organization_id) throw new Error('Set site_id and organization_id before starting a bound workspace connection.');
  const site = await client.get<{ id: string; version_id: string; organization_id?: string }>(config.site_id, '');
  if (site.id !== config.site_id || site.version_id !== config.version || site.organization_id !== config.organization_id) throw new Error('Portal Site, Organization or Version does not match typeroll.json. Run doctor before editing.');
}

export async function doctor(dir: string, offline: boolean, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch) {
  const checks: Array<{ check: string; status: 'passed' | 'required' | 'not_checked'; message: string }> = [];
  const config = await readWorkspace(dir);
  checks.push({ check: 'workspace', status: 'passed', message: 'Valid non-secret workspace configuration.' });
  const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => '');
  checks.push({ check: 'ignore_entries', status: ignores.every(rule => ignore.split(/\r?\n/).includes(rule)) ? 'passed' : 'required', message: 'Checks required .gitignore entries only. Run init if missing; inspect overriding rules and already tracked files separately.' });
  if (!config.site_id) checks.push({ check: 'site', status: 'required', message: 'Create/select a Site through hosted MCP or the portal, then set site_id in typeroll.json.' });
  if (offline) checks.push({ check: 'connection', status: 'not_checked', message: 'Offline check: authentication, permissions, Version and readiness were not checked.' });
  else {
    try {
      const client = workspaceClient(config, env, fetchImpl);
      await client.rootGet('sites');
      checks.push({ check: 'authentication', status: 'passed', message: 'The portal accepted the credential.' });
      if (config.site_id) {
        const site = await client.get<{ id: string; version_id: string; organization_id?: string }>(config.site_id, '');
        if (site.id !== config.site_id || site.version_id !== config.version) throw new Error('Site or Version differs from the workspace binding.');
        checks.push({ check: 'site_version', status: 'passed', message: 'Site and Version match the workspace.' });
        checks.push({ check: 'organization', status: config.organization_id && config.organization_id === site.organization_id ? 'passed' : 'required', message: site.organization_id ? `Confirm organization_id matches ${site.organization_id}.` : 'This portal does not return the Site Organization ID; verify it before writes.' });
        await client.get(config.site_id, 'capabilities');
        checks.push({ check: 'capabilities', status: 'passed', message: 'Capabilities are readable. Read relevant block schemas and app documentation on demand.' });
      }
      checks.push({ check: 'writes_and_publishing', status: 'not_checked', message: 'Read-only doctor. No edits, media transfer, app activation or publication was attempted; check publishing/import readiness for those tasks.' });
    } catch (error) {
      checks.push({ check: 'connection', status: 'required', message: error instanceof ApiError ? `Portal HTTP ${error.status}. Check credential scope, portal and Site/Version.` : 'Could not verify the connection. Check injected credentials, matching environment, network and Site/Version.' });
    }
  }
  return { passed: !checks.some(check => check.status === 'required'), generator_version: VERSION, checks };
}
