import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit, runInitCli } from '../src/init.js';
import { doctor, readWorkspace, defaultWorkspace, writeWorkspaceFiles, workspaceClient, workspaceSchema, verifyWorkspaceBinding } from '../src/workspace.js';

describe('agent-neutral workspace', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-workspace-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  it('creates a small non-secret scaffold with on-demand recipes and no client lock-in', async () => {
    await runInit({ dir });
    expect(await fs.readdir(dir)).not.toContain('.claude');
    expect(await fs.readdir(dir)).not.toContain('typeroll-skills');
    expect(await readWorkspace(dir)).toEqual(defaultWorkspace);
    expect(await read('AGENTS.md')).toContain('describe_tool');
    expect(await read('AGENTS.md')).not.toContain('loads them automatically');
    expect(await read('.gitignore')).toContain('.mcp.json');
    expect(await read('.gitignore')).toContain('.env');
    expect(await read('brief/site.md')).toContain('Editorial constraints');
  });
  it('preserves edited files and configuration while updating unchanged managed templates', async () => {
    await writeWorkspaceFiles(dir, { 'AGENTS.md': 'old', 'brief/site.md': 'original' }, false);
    await fs.writeFile(path.join(dir, 'brief/site.md'), 'customer brief');
    await fs.writeFile(path.join(dir, 'typeroll.json'), JSON.stringify({ ...defaultWorkspace, site_id: 'selected' }));
    const result = await writeWorkspaceFiles(dir, { 'AGENTS.md': 'new', 'brief/site.md': 'new defaults', 'typeroll.json': JSON.stringify(defaultWorkspace) }, true);
    expect(await read('AGENTS.md')).toBe('new');
    expect(await read('brief/site.md')).toBe('customer brief');
    expect((await readWorkspace(dir)).site_id).toBe('selected');
    expect(result.find(row => row.path === 'brief/site.md')?.action).toBe('modified');
  });
  it('reruns without duplicating ignore rules and keeps existing untracked agent instructions', async () => {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'My project rules');
    await runInit({ dir }); const ignore = await read('.gitignore');
    await runInit({ dir, update: true });
    expect(await read('AGENTS.md')).toBe('My project rules');
    expect(await read('.gitignore')).toBe(ignore);
  });
  it.each(['claude', 'cursor', 'vscode'] as const)('writes opt-in %s configuration without keys and preserves custom servers', async client => {
    const file = client === 'claude' ? '.mcp.json' : client === 'cursor' ? '.cursor/mcp.json' : '.vscode/mcp.json';
    await runInit({ dir, client });
    expect(await read(file)).toContain('workspace-mcp');
    expect(await read(file)).not.toContain('API_KEY');
    await fs.writeFile(path.join(dir, file), '{"custom":"preserve me"}');
    const updated = await runInit({ dir, client, update: true });
    expect(await read(file)).toBe('{"custom":"preserve me"}');
    expect(updated.files.find(row => row.path === file)?.action).toBe('modified');
  });
  it('installs optional recipes into a neutral directory and preserves edits on update', async () => {
    const source = path.join(dir, 'fixture'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'tr-new-site.md'), 'v1');
    await runInit({ dir, recipes: true, sourceDir: source });
    await fs.writeFile(path.join(source, 'tr-new-site.md'), 'v2');
    await runInit({ dir, recipes: true, sourceDir: source, update: true });
    expect(await read('typeroll-skills/tr-new-site.md')).toBe('v2');
    await fs.writeFile(path.join(dir, 'typeroll-skills/tr-new-site.md'), 'custom');
    await runInit({ dir, recipes: true, sourceDir: source, update: true });
    expect(await read('typeroll-skills/tr-new-site.md')).toBe('custom');
  });
  it('rejects symlink destinations before writing scaffold files', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-outside-'));
    try {
      await fs.symlink(outside, path.join(dir, 'brief'));
      await expect(runInit({ dir })).rejects.toThrow(/linked/);
      expect(await fs.readdir(outside)).toEqual([]);
      expect(await fs.readdir(dir)).toEqual(['brief']);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it('rejects unknown flags and unsafe credential-bearing portal config', async () => {
    expect(await runInitCli([dir, '--force'])).toBe(1);
    expect(workspaceSchema.safeParse({ ...defaultWorkspace, api_key: 'secret' }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...defaultWorkspace, portal: 'https://user:secret@example.com' }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...defaultWorkspace, portal: 'http://example.com' }).success).toBe(false);
  });
  it('checks the actual Site, Organization and Version with GETs only, without exposing credentials', async () => {
    await runInit({ dir });
    await fs.writeFile(path.join(dir, 'typeroll.json'), JSON.stringify({ ...defaultWorkspace, site_id: 'site', organization_id: 'org', version: 'draft-branch' }));
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(init?.method).toBe('GET'); calls.push(String(input));
      return Response.json(String(input).includes('/site/') && !String(input).includes('capabilities') ? { id: 'site', organization_id: 'org', version_id: 'draft-branch' } : { sites: [], supported: true });
    };
    const report = await doctor(dir, false, { TYPEROLL_API_KEY: 'test-secret' }, fetchImpl);
    expect(report.passed).toBe(true);
    expect(calls.filter(url => url.includes('/site/')).every(url => url.includes('version=draft-branch'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('test-secret');
    expect(report.checks.find(row => row.check === 'writes_and_publishing')?.status).toBe('not_checked');
    const mismatch = await doctor(dir, false, { TYPEROLL_API_KEY: 'test-secret' }, async () => Response.json({ id: 'other' }));
    expect(mismatch.passed).toBe(false);
  });
  it('refuses a bound MCP session when the portal Organization does not match', async () => {
    const config = { ...defaultWorkspace, site_id: 'site', organization_id: 'expected' };
    const client = workspaceClient(config, { TYPEROLL_API_KEY: 'synthetic' }, async () => Response.json({ id: 'site', version_id: 'main', organization_id: 'other' }));
    await expect(verifyWorkspaceBinding(config, client)).rejects.toThrow(/does not match/);
  });
  it('reports offline checks honestly and rejects environment conflicts', async () => {
    await runInit({ dir }); const report = await doctor(dir, true, {});
    expect(report.checks.find(row => row.check === 'connection')?.status).toBe('not_checked');
    expect(report.passed).toBe(false);
    expect(() => workspaceClient(defaultWorkspace, { TYPEROLL_API_KEY: 'secret', TYPEROLL_API_URL: 'https://wrong.example' })).toThrow(/conflicts/);
  });
});
