// Tests for the install-skills subcommand.
//
// The subcommand is a pure file-copy operation — no network, no MCP. We
// stand up a temporary source dir with fake `tr-*.md` files and verify
// the copy behaviour, including the skip-existing default and --force.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkills } from '../src/install-skills.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, 'utf8');
}

describe('installSkills', () => {
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    sourceDir = await makeTempDir('typeroll-skills-src-');
    destDir = await makeTempDir('typeroll-skills-dst-');
    // Seed source with a representative mix.
    await writeFile(path.join(sourceDir, 'tr-blog.md'), '# blog skill\n');
    await writeFile(path.join(sourceDir, 'tr-brand.md'), '# brand skill\n');
    await writeFile(path.join(sourceDir, 'tr-seo.md'), '# seo skill\n');
    // README must be ignored — it's package docs, not a skill.
    await writeFile(path.join(sourceDir, 'README.md'), '# not a skill\n');
    // A non-matching file must also be ignored.
    await writeFile(path.join(sourceDir, 'other.txt'), 'not a skill\n');
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(destDir, { recursive: true, force: true });
  });

  it('copies all tr-*.md files to an empty destination', async () => {
    const result = await installSkills({ dest: destDir, sourceDir });
    expect(result.copied.sort()).toEqual(['tr-blog.md', 'tr-brand.md', 'tr-seo.md']);
    expect(result.skipped).toEqual([]);
    expect(result.destination).toBe(path.resolve(destDir));

    const files = (await fs.readdir(destDir)).sort();
    expect(files).toEqual(['tr-blog.md', 'tr-brand.md', 'tr-seo.md']);
  });

  it('ignores README.md and non-tr- files', async () => {
    const result = await installSkills({ dest: destDir, sourceDir });
    expect(result.copied).not.toContain('README.md');
    expect(result.copied).not.toContain('other.txt');
    const files = await fs.readdir(destDir);
    expect(files).not.toContain('README.md');
    expect(files).not.toContain('other.txt');
  });

  it('creates the destination directory if it does not exist', async () => {
    const nested = path.join(destDir, 'a', 'b', 'c');
    const result = await installSkills({ dest: nested, sourceDir });
    expect(result.copied.length).toBe(3);
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it('skips existing files by default and reports them', async () => {
    // Pre-populate one of the destinations with user-edited content.
    await writeFile(path.join(destDir, 'tr-blog.md'), '# my edited version\n');

    const result = await installSkills({ dest: destDir, sourceDir });
    expect(result.copied.sort()).toEqual(['tr-brand.md', 'tr-seo.md']);
    expect(result.skipped).toEqual(['tr-blog.md']);

    // Verify the pre-existing file was preserved.
    const preserved = await fs.readFile(path.join(destDir, 'tr-blog.md'), 'utf8');
    expect(preserved).toBe('# my edited version\n');
  });

  it('overwrites existing files when force=true', async () => {
    await writeFile(path.join(destDir, 'tr-blog.md'), '# my edited version\n');

    const result = await installSkills({ dest: destDir, sourceDir, force: true });
    expect(result.copied.sort()).toEqual(['tr-blog.md', 'tr-brand.md', 'tr-seo.md']);
    expect(result.skipped).toEqual([]);

    const overwritten = await fs.readFile(path.join(destDir, 'tr-blog.md'), 'utf8');
    expect(overwritten).toBe('# blog skill\n');
  });

  it('throws a clear error if the source directory is missing', async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await expect(installSkills({ dest: destDir, sourceDir })).rejects.toThrow(
      /could not find bundled skills directory/i,
    );
  });

  it('throws if the source path is a file, not a directory', async () => {
    const bogusSource = path.join(sourceDir, 'not-a-dir.txt');
    // Cleanup the seeded dir entirely so bogus path is just a file.
    await fs.rm(sourceDir, { recursive: true, force: true });
    await writeFile(bogusSource, 'oops');
    await expect(installSkills({ dest: destDir, sourceDir: bogusSource })).rejects.toThrow(
      /not a directory/i,
    );
  });

  it('handles an empty source directory (zero skills)', async () => {
    // Replace contents with nothing.
    for (const f of await fs.readdir(sourceDir)) {
      await fs.rm(path.join(sourceDir, f));
    }
    const result = await installSkills({ dest: destDir, sourceDir });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
