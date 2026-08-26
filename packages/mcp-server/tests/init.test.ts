// Tests for the `init` subcommand. Like install-skills it's a pure
// filesystem operation. We stand up a temp skills source + a temp project
// dir and assert the scaffolding, idempotency, and .mcp.json merge rules.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/init.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe('runInit', () => {
  let sourceDir: string;
  let projectDir: string;

  beforeEach(async () => {
    sourceDir = await makeTempDir('tr-init-src-');
    projectDir = await makeTempDir('tr-init-dst-');
    await fs.writeFile(path.join(sourceDir, 'tr-new-site.md'), '# new site\n', 'utf8');
    await fs.writeFile(path.join(sourceDir, 'tr-brand.md'), '# brand\n', 'utf8');
    await fs.writeFile(path.join(sourceDir, 'README.md'), '# not a skill\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('scaffolds skills, config, AGENTS.md, env example and the imagegen lab', async () => {
    const result = await runInit({ dir: projectDir, sourceDir });

    // Skills copied (README ignored).
    expect(result.skills.copied.sort()).toEqual(['tr-brand.md', 'tr-new-site.md']);
    expect(await exists(path.join(projectDir, '.claude', 'skills', 'tr-new-site.md'))).toBe(true);

    // All four scaffolding files present.
    expect(await exists(path.join(projectDir, '.mcp.json'))).toBe(true);
    expect(await exists(path.join(projectDir, 'AGENTS.md'))).toBe(true);
    expect(await exists(path.join(projectDir, '.env.example'))).toBe(true);
    expect(await exists(path.join(projectDir, 'images', 'lab', '.gitignore'))).toBe(true);

    // .mcp.json carries the typeroll server entry with placeholders.
    const config = await readJson(path.join(projectDir, '.mcp.json'));
    const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.typeroll.env.TYPEROLL_API_URL).toBe('https://app.typeroll.com');
    expect(servers.typeroll.env.TYPEROLL_API_KEY).toContain('REPLACE');
    expect(servers.typeroll.env.TYPEROLL_SITE_ID).toContain('REPLACE');

    // The lab .gitignore ignores everything but itself.
    const labIgnore = await fs.readFile(path.join(projectDir, 'images', 'lab', '.gitignore'), 'utf8');
    expect(labIgnore).toContain('!.gitignore');
  });

  it('is idempotent: a second run keeps user edits', async () => {
    await runInit({ dir: projectDir, sourceDir });

    // User edits AGENTS.md and pastes a real key into .mcp.json.
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), '# my own notes\n', 'utf8');
    const cfgPath = path.join(projectDir, '.mcp.json');
    const cfg = await readJson(cfgPath);
    (cfg.mcpServers as Record<string, { env: Record<string, string> }>).typeroll.env.TYPEROLL_API_KEY =
      'typeroll_live_real_secret';
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const result = await runInit({ dir: projectDir, sourceDir });

    // AGENTS.md left untouched.
    expect(await fs.readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).toBe('# my own notes\n');
    expect(result.files.find((f) => f.path === 'AGENTS.md')?.action).toBe('skipped');

    // The pasted key survives the merge — placeholders never overwrite real values.
    const after = await readJson(cfgPath);
    const env = (after.mcpServers as Record<string, { env: Record<string, string> }>).typeroll.env;
    expect(env.TYPEROLL_API_KEY).toBe('typeroll_live_real_secret');
  });

  it('merges into an existing .mcp.json without dropping other servers', async () => {
    // Pre-existing config with a DIFFERENT server and no typeroll entry.
    await fs.writeFile(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'foo', args: [], env: {} } } }, null, 2),
      'utf8',
    );

    await runInit({ dir: projectDir, sourceDir });

    const config = await readJson(path.join(projectDir, '.mcp.json'));
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeDefined();
    expect(servers.typeroll).toBeDefined();
  });

  it('--force overwrites files and replaces the typeroll entry', async () => {
    await runInit({ dir: projectDir, sourceDir });
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), '# edited\n', 'utf8');

    const result = await runInit({ dir: projectDir, sourceDir, force: true });

    expect(await fs.readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Typeroll');
    expect(result.files.find((f) => f.path === 'AGENTS.md')?.action).toBe('created');
  });

  it('leaves a malformed .mcp.json untouched rather than corrupting it', async () => {
    const cfgPath = path.join(projectDir, '.mcp.json');
    await fs.writeFile(cfgPath, '{ this is not json', 'utf8');

    const result = await runInit({ dir: projectDir, sourceDir });

    expect(await fs.readFile(cfgPath, 'utf8')).toBe('{ this is not json');
    expect(result.files.find((f) => f.path === '.mcp.json')?.action).toBe('skipped');
  });
});
