import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VERSION } from './version.js';
import { BUNDLED_WORKSPACE_TEMPLATES } from './bundled-content.js';
import { ApiError, TyperollClient } from './client.js';
import { isSecureApiUrl } from './api-url.js';

export const workspaceSchema = z.object({
  schema_version: z.literal(1),
  portal: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && isSecureApiUrl(url);
  }, 'Use an HTTPS portal origin (HTTP is allowed only on loopback).'),
  organization_id: z.string().min(1).nullable(), site_id: z.string().min(1).nullable(),
  version: z.string().min(1), tool_mode: z.enum(['compact', 'full']),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export const defaultWorkspace: Workspace = { schema_version: 1, portal: 'https://app.typeroll.com', organization_id: null, site_id: null, version: 'main', tool_mode: 'compact' };
const lockSchema = z.object({ schema_version: z.literal(1), generator_version: z.string(), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const ignores = ['.typeroll/', '.env', '.env.*', '!.env.example', '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'qa/reports/', 'sources/private/', '**/__pycache__/', 'scripts/typeroll/node_modules/'];

export const agentInstructions = `# Working on this website

Read typeroll.json, brief/site.md, brief/rules.md and decisions.md first. Read
other brief/ files and workflows/ only when relevant. Confirm the portal, Organization,
Site and working Version before writes. This workspace is not the generated
publication repository. The CMS owns current content and configuration; local
sources are proposals unless the user explicitly adopts them.

## Guided start

When the owner needs guidance or a material decision is missing, start or resume
workflows/interview.md. Read brief/interview.md and existing answers first; ask
one short question at a time and save progress. Do not repeat confirmed questions
or treat silence as approval. For a complete brief, proceed directly to
workflows/new-site.md or workflows/migration.md. All kickoff prompts live here
in the workspace; public docs explain the flow and link to these source files.

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
- Read pages/ notes before editing; follow workflows/page-notes.md for sources,
  dated logs, external-link review and archiving. Keep internal notes out of public output.
- Use native editable blocks; document necessary exceptions and design decisions.
- Configure palette/font roles and design scales in site settings. Read workflows/design.md
  before styling blocks; run lint_design_tokens and document hardcoded exceptions.
- Discover get_composition_starter for qualified native starting layouts. Read one
  recipe at a time; map it to the actual schema. Never overwrite an existing
  template with a starter. Sections own gutters; avoid extra nested padding.
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
- The signed preview is for content and layout review. Verify embeds, consent,
  analytics, fonts and measured design checks on the published test address.
- Publish one Site at a time per Organization: all Sites share one build engine.
- Record Typeroll defects in qa/typeroll-platform-feedback.md. Do not resume
  affected publishing until the fix is confirmed live.
- Never edit generated publishing source to change CMS content. Do not overwrite
  current CMS or owner answers from an old local snapshot.

## Migrations

Read tr-migration-evidence, then the source-specific recipe (tr-migrate-wp,
tr-import-url, tr-migrate-astro or tr-migrate-multisite). Record text_intent and design_intent separately as preserve or renew
in brief/migration.md; design includes images. Ask if either is unclear. Standard blocks first, reviewed
custom types next, documented HTML exceptions last. Preserve or meaningfully
redirect every old public URL. Import completion is not block reconstruction
or launch acceptance. Compare text and design/images separately: preserved dimensions to the source,
renewed dimensions to their approved brief. New design never permits rewriting preserved text. Start with workflows/migration.md for the kickoff
prompt. The agent rebuilds imported HTML using ordinary block tools; the owner
does not need to manually convert each Page. No automatic converter is available.
Discover tools and recipes on demand. Read scripts/README.md for version-bound
pre-deploy and hosted QA tools. Follow workflows/design.md for layout defaults.

## Project rules and search strategy

Record the owner's preferences and durable constraints in brief/rules.md; put
approved search intent, topic coverage and URL/indexing strategy in brief/seo.md.
These are project decisions, not CMS settings or permission to publish. If a
request conflicts with an agreed rule, ask and record the resulting decision.
Use workflows/README.md to find the relevant routine, not load every recipe.

## Everyday requests

- Links, images, menus, settings, analytics and site-wide changes: read the
  tr-edit-site recipe. Shared content becomes one global block, not N edits.
- FAQ, recipe and event pages: add_faq_schema, add_recipe_schema and
  add_event_schema build validated JSON-LD (see tr-seo); don't hand-write it.
- A blank site or the starter design: tr-starter-design lists its variables.
- The portal's built-in AI is optional. When an AI workflow (site planning,
  content generation or improvement, schema markup) reports ai_not_enabled,
  do the work yourself with the recipe it names and say so; don't retry.

Store credentials in the client's private settings or injected environment.
Run the workspace doctor after setup and after changing the binding.
`;
export const workspaceTemplates: Record<string, string> = {
  ...BUNDLED_WORKSPACE_TEMPLATES,
  'AGENTS.md': agentInstructions,
  'README.md': `# Website workspace\n\nKeep project intent here; edit the website through Typeroll CMS.\n\n1. Read AGENTS.md. For guidance, ask your agent to start or resume workflows/interview.md. Otherwise use workflows/new-site.md or workflows/migration.md. Save confirmed goals, rules and SEO strategy in brief/; record text and design/image choices separately for migrations.\n2. Connect hosted MCP at https://app.typeroll.com/api/mcp?tools=compact.\n3. Use an Organization key to create a site, or select an existing one.\n4. Record its IDs and working version in typeroll.json. No secrets belong there.\n5. Run npx @typeroll/mcp-server doctor . (inject TYPEROLL_API_KEY privately).\n\nStart guide: https://typeroll.com/docs/getting-started/agent-workspace/\n\nUpdate the generated scaffold with npx @typeroll/mcp-server init . --update.\nEdited files are preserved and reported for manual reconciliation. Optional local\nrecipes: init . --recipes. They are reference Markdown, not automatically loaded.\n`,
  'brief/site.md': '# Site brief\n\n## Purpose and audience\n\n## Languages and scope\n\n## Primary user journeys\n\n## Content authority and sources\n\n## Editorial constraints and forbidden internal markers\n',
  'brief/brand.md': '# Brand\n\n## Voice and tone\n\n## Visual direction and references\n\n## Typography, colors and image policy\n\n## Desktop and mobile navigation\n\nRecord intent here; current design tokens belong in CMS settings. Choose semantic palette roles and typography/spacing steps; record deliberate hardcoded exceptions in decisions.md.\n',
  'brief/content-model.md': '# Content model\n\n## Page plan\n\nThe pages the business needs, agreed before design work: home, about, services or products, pricing, contact, privacy policy and other legal pages, comparisons and articles as relevant. One row per page: title, path, purpose, primary search intent and status (planned, built, published).\n\n| Title | Path | Purpose | Search intent | Status |\n| --- | --- | --- | --- | --- |\n\n## Page types and routes\n\n## Fields and references\n\n## Shared templates and partials\n\n## Taxonomy and navigation\n\nUse the current CMS schema. This document describes decisions, not a second schema store.\n',
  'brief/rules.md': "# Owner preferences and project rules\n\n## Confirmed rules\n\nRecord each rule, its scope, who approved it and the date. Separate confirmed rules from proposals.\n\n## Writing and factual accuracy\n\nVoice, terminology, prohibited claims, source requirements and legal copy that must not be rewritten.\n\n## Design and editing\n\nBrand constraints, accessibility, editable content, standard/custom blocks and documented HTML exceptions.\n\n## Operations and approval\n\nWho may approve content, publication, DNS changes and messages? Credentials stay outside this repository.\n\n## Exceptions and superseded rules\n\nLink decisions.md; do not silently override a confirmed rule. Project notes do not grant permissions beyond the user's authorization or account access.\n",
  'brief/seo.md': "# SEO strategy\n\n## Launch basics\n\nAsk the owner early; each item is optional. Record a skipped item here with the reason. Current values live in the CMS settings.\n\n- Default share image (`default_og_image`): chosen, uploaded or created with tr-imagegen; 1200×630 PNG or JPEG. Never a generated title card.\n- Organization (`organization`): business name and logo, and official profile URLs (`same_as`).\n- Page plan: agreed in brief/content-model.md, including privacy policy and contact pages.\n- Search Console: property type (Domain or URL prefix), verification method, who has access and the date the sitemap was submitted.\n- AI crawlers (`ai_crawler_policy`): allow_all (default), no_training or block_all, and any Cloudflare zone policy that must match.\n\n## Business goals, audience, markets and languages\n\n## Search intent and topic coverage\n\nRecord research sources and dates. Distinguish evidence from assumptions; do not invent traffic or ranking forecasts.\n\n## Page roles and URL plan\n\nContent types, useful landing pages, taxonomy, internal links and routes to preserve or redirect. Avoid near-duplicate pages created only for keyword variants.\n\n## Indexing and canonical policy\n\nWhich pages should be indexable, public noindex, or private? Record deliberate canonical overrides and sitemap policy; actual values live in the CMS.\n\n## Editorial standards and structured data\n\nUnique useful copy, supported claims, descriptive titles and links, accessible image text, schema matching visible content. No fixed title length or word count is a hard SEO rule.\n\n## Measurement and review\n\nBaseline, analytics/consent decisions, measures of success and review dates. Never store credentials or private analytics exports here.\n",
  'workflows/README.md': "# Project routines\n\nRead only the relevant routine and discover current tool schemas through MCP.\nProject files record intent; the CMS owns current content and configuration.\n\n| Task | Project context | On-demand recipe |\n| --- | --- | --- |\n| Guided start | workflows/interview.md, brief/interview.md | Ask one question at a time; resume confirmed answers |\n| New website | workflows/new-site.md, brief/site.md, brief/brand.md, brief/content-model.md | tr-new-site, tr-starter-design |\n| Migration | workflows/migration.md, brief/migration.md | tr-migration-evidence, then tr-migrate-wp or the matching source recipe |\n| Everyday editing | brief/rules.md, pages/ notes and the relevant Page | tr-edit-site |\n| Page notes and review | workflows/page-notes.md, pages/README.md, pages/index.md | Read before edits; update logs afterward |\n| SEO | brief/seo.md and current site settings | tr-seo |\n| New reusable block | brief/brand.md and recorded editing needs | tr-custom-blocks |\n| Verification and publication | qa/checklist.md, decisions.md | Current preview/deploy tools and publishing readiness |\n| Launch | qa/checklist.md (Launch), brief/seo.md (Launch basics) | read_site_readiness, tr-seo |\n\nAdd project-specific routines here with inputs, steps, acceptance evidence and approval boundaries. Do not copy the complete Typeroll manual or private app guides. Discover enabled app guidance with read_app_documentation. Load a recipe when needed so instructions stay current and context stays small.\n",
  'decisions.md': '# Decisions\n\nRecord date, decision, reason, approved scope and alternatives when useful. For design-token exceptions include the source/block, fixed value, reason (e.g. white text on a photograph) and review criteria.\n',
  'sources/README.md': '# Sources\n\nStore research references and copy proposals. Record source URLs and dates.\nPrivate extracts belong in ignored private/ or an approved external store.\nDo not treat local drafts as current CMS content or commit media libraries.\n',
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

/** The hosted Typeroll Cloud portal: the only origin trusted from typeroll.json alone. */
export const OFFICIAL_PORTAL_ORIGIN = 'https://app.typeroll.com';

/** Raised before any credential is sent when the committed portal is not confirmed by the environment. */
export class UntrustedPortalError extends Error {}

/**
 * typeroll.json is committed and can be changed by anyone who can open a pull
 * request, so its portal alone never receives the injected API key. Another
 * origin must be confirmed through the private TYPEROLL_API_URL setting.
 */
export function assertTrustedPortal(config: Workspace, env: NodeJS.ProcessEnv) {
  const portal = config.portal.replace(/\/$/, '');
  const confirmed = env.TYPEROLL_API_URL?.trim().replace(/\/$/, '');
  if (confirmed) {
    if (confirmed !== portal) throw new Error('TYPEROLL_API_URL conflicts with typeroll.json.');
    return;
  }
  if (portal !== OFFICIAL_PORTAL_ORIGIN) {
    throw new UntrustedPortalError(`typeroll.json names the portal ${portal}. The API key is sent only to ${OFFICIAL_PORTAL_ORIGIN} unless you confirm another portal: set TYPEROLL_API_URL=${portal} in your private client settings or environment.`);
  }
}

export function workspaceClient(config: Workspace, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) {
  if (!env.TYPEROLL_API_KEY) throw new Error('Inject TYPEROLL_API_KEY through private client settings or the environment.');
  assertTrustedPortal(config, env);
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
      checks.push({ check: 'connection', status: 'required', message: error instanceof ApiError ? `Portal HTTP ${error.status}. Check credential scope, portal and Site/Version.` : error instanceof UntrustedPortalError ? error.message : 'Could not verify the connection. Check injected credentials, matching environment, network and Site/Version.' });
    }
  }
  return { passed: !checks.some(check => check.status === 'required'), generator_version: VERSION, checks };
}
