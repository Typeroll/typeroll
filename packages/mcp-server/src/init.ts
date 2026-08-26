// `init` subcommand for the typeroll-mcp CLI.
//
// A superset of `install-skills`: it bootstraps a LOCAL project directory for
// agent-driven Typeroll work. On top of copying the bundled skills it writes
// the connection config (.mcp.json), an AGENTS.md pointer, and the scaffolding
// the imagegen lab expects (.env.example + images/lab/.gitignore).
//
// Like install-skills it's a pure filesystem operation — no network, no API
// key needed — which is why index.ts dispatches it BEFORE env-var validation.
//
// Everything is idempotent: rerunning never clobbers a file the user has
// edited. `--force` opts into overwriting. Existing values inside .mcp.json
// are always preserved (we only fill in the keys we own that are missing),
// even without --force, so re-running can't wipe a key the user pasted in.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { installSkills, type InstallSkillsResult } from './install-skills.js';

const API_URL_DEFAULT = 'https://app.typeroll.com';
const API_KEY_PLACEHOLDER = 'typeroll_live_REPLACE_WITH_YOUR_KEY';
const SITE_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_SITE_ID';

export interface InitOptions {
  /** Destination project directory. Created if missing. */
  dir: string;
  /** Overwrite files that already exist (and replace the whole typeroll
   *  .mcp.json entry instead of merging). Default: false. */
  force?: boolean;
  /** Override the bundled skills source dir (testing only). */
  sourceDir?: string;
}

/** What `init` did to one path. `created` = freshly written, `merged` =
 *  existing file augmented in place, `skipped` = left untouched (already
 *  present, no --force). */
export type InitAction = 'created' | 'merged' | 'skipped';

export interface InitResult {
  dir: string;
  skills: InstallSkillsResult;
  files: Array<{ path: string; action: InitAction }>;
}

/** Write `contents` to `file` unless it already exists (idempotent). With
 *  `force` it always writes. Returns whether it created or skipped. */
async function writeIfMissing(
  file: string,
  contents: string,
  force: boolean,
): Promise<InitAction> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!force) {
    try {
      await fs.access(file);
      return 'skipped';
    } catch {
      // Doesn't exist — fall through to write.
    }
  }
  await fs.writeFile(file, contents, 'utf8');
  return 'created';
}

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function typerollServerEntry(): McpServerEntry {
  return {
    command: 'npx',
    args: ['-y', '@typeroll/mcp-server'],
    env: {
      TYPEROLL_API_URL: API_URL_DEFAULT,
      TYPEROLL_API_KEY: API_KEY_PLACEHOLDER,
      TYPEROLL_SITE_ID: SITE_ID_PLACEHOLDER,
    },
  };
}

/**
 * Create or merge the `typeroll` entry in `<dir>/.mcp.json`.
 *
 * - No file → create it with just the typeroll server.
 * - File without a typeroll entry → add it, preserving every other server.
 * - File WITH a typeroll entry → fill in only the env keys we own that are
 *   missing; never overwrite a value the user already set (unless --force,
 *   which replaces the whole entry).
 * - Malformed JSON → left untouched, reported as `skipped` (we refuse to
 *   stomp on something we can't safely parse).
 */
async function writeMcpConfig(dir: string, force: boolean): Promise<InitAction> {
  const file = path.join(dir, '.mcp.json');
  let existing: Record<string, unknown> | null = null;
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    // ENOENT → brand new file. Any other parse error → don't touch it.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return 'skipped';
    }
  }

  if (!existing) {
    const config = { mcpServers: { typeroll: typerollServerEntry() } };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return 'created';
  }

  const servers =
    (existing.mcpServers as Record<string, McpServerEntry> | undefined) ?? {};
  const had = !!servers.typeroll;

  if (!had || force) {
    servers.typeroll = typerollServerEntry();
  } else {
    // Merge: keep the user's command/args/env, only add env keys we own that
    // are absent. Never overwrite a value they already pasted in.
    const entry = servers.typeroll;
    entry.env = entry.env ?? {};
    const defaults = typerollServerEntry().env;
    for (const [k, v] of Object.entries(defaults)) {
      if (entry.env[k] === undefined) entry.env[k] = v;
    }
  }

  existing.mcpServers = servers;
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return had && !force ? 'merged' : had ? 'created' : 'merged';
}

const AGENTS_POINTER = `# Working on a Typeroll site

This project is wired to a Typeroll site through \`@typeroll/mcp-server\`.

- **Skills** live in \`.claude/skills/\` (the \`tr-*.md\` recipes). Your agent
  loads them automatically; start by skimming \`tr-new-site\` for the
  bootstrap flow, or run the MCP tool \`list_skills\` to see them all.
- **Connection** is configured in \`.mcp.json\`. Fill in \`TYPEROLL_API_KEY\`
  (create one in the portal under Settings → API keys) and
  \`TYPEROLL_SITE_ID\`.
- **Discover before you write.** Call \`get_site\`, \`read_site_settings\`,
  \`list_pages\`, and \`list_block_types\` before proposing changes so you
  mirror the site's conventions.
- **Source of truth = the live site (the API), by default.** What you read
  back through the MCP (\`read_page\`, \`read_partial\`, \`read_site_settings\`)
  is canonical. Files in this folder — \`sources/*.md\` copy drafts, briefs —
  are PROPOSALS; treat them as authoritative only when explicitly told "use
  the copy in \`<file>\`". When rebuilding/redesigning, derive copy from the
  live page, not a local draft. If you edit copy on the live site, sync it
  back to the draft file in the same pass so they don't diverge.
- **A design review covers appearance AND readability, not just structure.**
  Before calling a build/redesign done, screenshot it at desktop (~1440px) and
  mobile (~390px) and judge the visuals: logo fully visible (not clipped by a
  header's overflow:hidden) + legible + brand-compliant against its real background
  — screenshot the header in context, not the logo element in isolation (that hides
  layout clipping); a light wordmark must not sit bare on a light surface. Text
  contrast, no horizontal scroll or mid-word breaks, all images rendered, mobile
  layout collapsed. "Copy present + no overflow" is not a design review — never
  call a design perfect/approved off structural metrics alone.
- **Image generation** runs locally in \`images/lab/\` — copy
  \`.env.example\` to \`.env\` and add provider keys (see the \`tr-imagegen\`
  skill). Only picked winners get uploaded to the media library.

The bundled MCP tools \`list_skills\` / \`read_skill\` expose the full
playbook at runtime — reach for them first when a task looks like
"build / migrate / redesign a site".
`;

const ENV_EXAMPLE = `# Image-generation lab — local provider keys for the tr-imagegen skill.
# Copy this file to .env and fill in whichever providers you use. The lab
# writes candidates to images/lab/ (gitignored); only picked winners are
# uploaded to the Typeroll media library.

# Google Gemini (image generation)
GEMINI_API_KEY=

# OpenAI (image generation)
OPENAI_API_KEY=

# Higgsfield (image / video generation)
HIGGSFIELD_API_KEY=
`;

const LAB_GITIGNORE = `# Generated image candidates — local scratch, never committed.
# Only winners picked into the media library belong in version control.
*
!.gitignore
`;

/**
 * Bootstrap `dir` for agent-driven Typeroll work. Idempotent; pass
 * `force` to overwrite existing files.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const dir = path.resolve(opts.dir);
  const force = opts.force ?? false;
  await fs.mkdir(dir, { recursive: true });

  const skills = await installSkills({
    dest: path.join(dir, '.claude', 'skills'),
    force,
    sourceDir: opts.sourceDir,
  });

  const files: InitResult['files'] = [];
  files.push({ path: '.mcp.json', action: await writeMcpConfig(dir, force) });
  files.push({
    path: 'AGENTS.md',
    action: await writeIfMissing(path.join(dir, 'AGENTS.md'), AGENTS_POINTER, force),
  });
  files.push({
    path: '.env.example',
    action: await writeIfMissing(path.join(dir, '.env.example'), ENV_EXAMPLE, force),
  });
  files.push({
    path: 'images/lab/.gitignore',
    action: await writeIfMissing(
      path.join(dir, 'images', 'lab', '.gitignore'),
      LAB_GITIGNORE,
      force,
    ),
  });

  return { dir, skills, files };
}

/**
 * CLI entry point — parses argv (after the `init` token has been removed)
 * and prints human-readable output. Returns an exit code.
 */
export async function runInitCli(args: string[]): Promise<number> {
  let dir: string | undefined;
  let force = false;
  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return 0;
    } else if (!dir && !arg.startsWith('-')) {
      dir = arg;
    } else {
      console.error(`typeroll-mcp init: unrecognised argument: ${arg}`);
      printHelp();
      return 1;
    }
  }

  const target = dir ?? '.';

  try {
    const result = await runInit({ dir: target, force });
    const skillsTotal = result.skills.copied.length + result.skills.skipped.length;
    console.log(`typeroll-mcp: initialised project at ${result.dir}`);
    console.log('');
    console.log(`  skills    .claude/skills/  (${result.skills.copied.length} copied, ${result.skills.skipped.length} kept of ${skillsTotal})`);
    for (const f of result.files) {
      const verb =
        f.action === 'created' ? 'wrote' : f.action === 'merged' ? 'merged' : 'kept';
      console.log(`  ${verb.padEnd(9)} ${f.path}`);
    }
    console.log('');
    console.log('Next steps:');
    console.log('  1. Create an API key in the Typeroll portal (Settings → API keys).');
    console.log('  2. Edit .mcp.json: set TYPEROLL_API_KEY and TYPEROLL_SITE_ID.');
    console.log('  3. (Optional) cp .env.example .env and add image-provider keys.');
    console.log('  4. Open this folder in Claude Code — it picks up .mcp.json + .claude/skills/.');
    console.log('  5. Ask the agent to "connect to Typeroll and confirm the key works".');
    if (result.files.some((f) => f.action === 'skipped')) {
      console.log('');
      console.log('Some files already existed and were kept — rerun with --force to overwrite.');
    }
    return 0;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`typeroll-mcp init: ${reason}`);
    return 1;
  }
}

function printHelp(): void {
  console.error('');
  console.error('Usage: npx @typeroll/mcp-server init [directory] [--force]');
  console.error('');
  console.error('Bootstraps a local project for agent-driven Typeroll work:');
  console.error('  - copies the bundled skills to .claude/skills/');
  console.error('  - writes/merges .mcp.json with a typeroll server entry');
  console.error('  - writes an AGENTS.md pointer, .env.example, images/lab/.gitignore');
  console.error('');
  console.error('Directory defaults to the current folder. Idempotent: rerunning');
  console.error('never clobbers your edits, and existing .mcp.json values are kept.');
  console.error('');
  console.error('Options:');
  console.error('  --force, -f             Overwrite existing files (replaces the typeroll .mcp.json entry)');
  console.error('  --help,  -h             Show this help');
}
