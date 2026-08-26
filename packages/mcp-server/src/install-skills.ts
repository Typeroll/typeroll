// install-skills subcommand for the typeroll-mcp CLI.
//
// Copies the bundled skill markdown files from this package's `skills/`
// directory into a destination directory the user provides. Used to seed
// `.claude/skills/` (project scope) or `~/.claude/skills/` (user scope) so
// Claude Code picks up Typeroll-specific skill recipes.
//
// This subcommand does NOT need TYPEROLL_API_URL / TYPEROLL_API_KEY — it's a
// pure file copy. Putting the dispatch in index.ts before the env-var
// validation is the only thing that matters for that.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the bundled skills directory. At runtime this file lives at
// <package>/dist/install-skills.js (after tsc); skills/ is a sibling of dist/.
// fileURLToPath gives us a real OS path that works on every platform.
// Exported so the skill-discovery tools (tools/skills.ts) resolve the exact
// same directory without duplicating the `..`/`skills` dance.
export function skillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'skills');
}

export interface InstallSkillsResult {
  destination: string;
  copied: string[];
  skipped: string[]; // files that already existed and weren't overwritten
}

export interface InstallSkillsOptions {
  /** Destination directory. Created if missing. */
  dest: string;
  /** If true, overwrite files that already exist. Default: false. */
  force?: boolean;
  /** Override source dir (testing only). */
  sourceDir?: string;
}

/**
 * Copy all `tr-*.md` files from the bundled skills directory to `dest`.
 * Returns a summary so callers can render output. Throws on filesystem errors
 * the caller didn't ask for.
 */
export async function installSkills(opts: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const source = opts.sourceDir ?? skillsDir();
  const force = opts.force ?? false;

  // Validate the source dir exists. If this fails the package install is
  // broken (skills/ missing from the tarball) — surface clearly.
  try {
    const stat = await fs.stat(source);
    if (!stat.isDirectory()) {
      throw new Error(`bundled skills path is not a directory: ${source}`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`could not find bundled skills directory at ${source}: ${reason}`);
  }

  // Resolve destination. Create it if missing (mkdir -p semantics).
  const dest = path.resolve(opts.dest);
  await fs.mkdir(dest, { recursive: true });

  // Only copy tr-*.md — README.md in skills/ is package-internal, not a skill.
  const entries = await fs.readdir(source);
  const skillFiles = entries.filter((f) => f.startsWith('tr-') && f.endsWith('.md')).sort();

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const file of skillFiles) {
    const target = path.join(dest, file);
    if (!force) {
      try {
        await fs.access(target);
        skipped.push(file);
        continue;
      } catch {
        // File doesn't exist — proceed to copy.
      }
    }
    await fs.copyFile(path.join(source, file), target);
    copied.push(file);
  }

  return { destination: dest, copied, skipped };
}

/**
 * CLI entry point — parses argv (after the subcommand token has been
 * removed) and prints human-readable output. Returns exit code.
 */
export async function runInstallSkillsCli(args: string[]): Promise<number> {
  let dest: string | undefined;
  let force = false;
  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return 0;
    } else if (!dest && !arg.startsWith('-')) {
      dest = arg;
    } else {
      console.error(`typeroll-mcp install-skills: unrecognised argument: ${arg}`);
      printHelp();
      return 1;
    }
  }

  if (!dest) {
    console.error('typeroll-mcp install-skills: missing destination directory.');
    printHelp();
    return 1;
  }

  try {
    const result = await installSkills({ dest, force });
    const total = result.copied.length + result.skipped.length;
    console.log(`typeroll-mcp: installed skills to ${result.destination}`);
    console.log(`  copied:  ${result.copied.length}/${total}`);
    if (result.skipped.length > 0) {
      console.log(`  skipped: ${result.skipped.length} (already exist; rerun with --force to overwrite)`);
      for (const f of result.skipped) console.log(`    - ${f}`);
    }
    if (result.copied.length > 0) {
      for (const f of result.copied) console.log(`    + ${f}`);
    }
    return 0;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`typeroll-mcp install-skills: ${reason}`);
    return 1;
  }
}

function printHelp(): void {
  console.error('');
  console.error('Usage: npx @typeroll/mcp-server install-skills <destination> [--force]');
  console.error('');
  console.error('Copies bundled Typeroll skill markdown files to the destination directory.');
  console.error('');
  console.error('Common destinations:');
  console.error('  .claude/skills          Project-scoped (recommended)');
  console.error('  ~/.claude/skills        User-scoped (available in every project)');
  console.error('');
  console.error('Options:');
  console.error('  --force, -f             Overwrite files that already exist');
  console.error('  --help,  -h             Show this help');
}
