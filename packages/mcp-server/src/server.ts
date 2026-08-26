// Transport-agnostic MCP server builder. Wraps an McpServer instance with
// the full Typeroll tool surface and either binds it to a single fixed site
// (stdio, site-scoped HTTP) or makes it multi-site (org-scoped HTTP).
//
// In multi-site mode every tool's input schema gains a required `site_id`
// argument; the handler wrapper validates that the id is in the allowed
// list AND that the share's permission level covers the operation (read
// vs write). This is the plumbing the hosted MCP plan calls out as
// safety-critical when one connector can touch many sites.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { TyperollClient } from './client.js';
import { pageTools } from './tools/pages.js';
import { partialTools } from './tools/partials.js';
import { collectionTools } from './tools/collections.js';
import { mediaTools } from './tools/media.js';
import { redirectTools } from './tools/redirects.js';
import { migrationTools } from './tools/migration.js';
import { formTools } from './tools/forms.js';
import { searchTools } from './tools/search.js';
import { bulkTools } from './tools/bulk.js';
import { versionTools } from './tools/versions.js';
import { deployTools } from './tools/deploy.js';
import { previewTools } from './tools/preview.js';
import { blockTypeTools } from './tools/block-types.js';
import { pageBlockTools } from './tools/page-blocks.js';
import { workingCopyTools } from './tools/working-copy.js';
import { settingsTools } from './tools/settings.js';
import { siteTools } from './tools/sites.js';
import { domainTools } from './tools/domain.js';
import { funnelAttributionTools } from './tools/funnel-attribution.js';
import { appTools } from './tools/apps.js';
import { skillTools } from './tools/skills.js';
import { fail, type ToolDef, type ToolDeps } from './tools/helpers.js';
import { VERSION } from './version.js';

/** What permission a tool needs to run. Maps onto the share model: a
 *  read-shared site can `read`-list but cannot mutate. Mode `write` is the
 *  default — applied to anything that isn't trivially side-effect-free. */
type ToolEffect = 'read' | 'write' | 'admin';

const PERM_RANK: Record<ToolEffect, number> = { read: 0, write: 1, admin: 2 };

/**
 * Classify a tool by name into the minimum permission needed. We keep this
 * conservative — anything that mutates is `write`. The MCP route's per-call
 * gate then checks `effect <= sitePermission`.
 *
 * Naming convention is followed by all 16 tool files: read paths are
 * `list_*` / `read_*` / `get_*` / `preview_*` / `search_*`; everything else
 * mutates.
 */
function effectFor(name: string): ToolEffect {
  if (
    name === 'list_apps'
    || name === 'read_app'
    || name === 'update_app'
    || name === 'read_funnel_attribution'
    || name === 'update_funnel_attribution'
  ) return 'admin';
  if (
    name.startsWith('list_') ||
    name.startsWith('read_') ||
    name.startsWith('get_') ||
    name.startsWith('batch_read_') ||
    name.startsWith('preview_') ||
    name.startsWith('search_')
  ) {
    return 'read';
  }
  return 'write';
}

export interface AllowedSite {
  siteId: string;
  permission: 'read' | 'write' | 'admin';
  /** Display name — surfaced in the "site_id" arg description so the model
   *  sees a list it can pick from. */
  name?: string;
}

export interface BuildServerOptions {
  /** Shared HTTP client (or test fake). Tools call this. */
  client: TyperollClient;
  /** Bind the server to a single site. Mutually exclusive with `allowedSites`. */
  fixedSiteId?: string;
  /** Multi-site mode: every tool gains a `site_id` arg, validated against this list. */
  allowedSites?: AllowedSite[];
  info?: { name: string; version: string };
}

const DEFAULT_INFO = { name: 'typeroll', version: VERSION };

/**
 * Server-level instructions — returned in the MCP `initialize` response and
 * surfaced to the model by every client (Claude Code stdio AND the hosted
 * Desktop/claude.ai connector) with zero user setup. This is the one channel
 * that reaches every consumer automatically, so it carries the highest-value
 * conventions and POINTS at the deeper, on-demand content (the bundled skills,
 * reachable via list_skills/read_skill) rather than duplicating it.
 */
export const SERVER_INSTRUCTIONS = `
Typeroll MCP — operating manual. You're managing a Typeroll site (a static-site
CMS: database content compiles to a fast static site on a deploy). The full
playbook ships with this server — use it:

0. For the complete operating context (data model, conventions, safety
   boundaries, tool-family reference), call read_guide once. list_skills +
   read_skill give the task-specific recipes on top of it.
1. When the task is "build / migrate / redesign / brand a site", call
   list_skills FIRST, then read_skill <name> for the step-by-step recipe
   (tr-new-site, tr-migrate-wp, tr-brand, tr-blog, tr-responsive, …). These are
   the canonical how-to; don't improvise what a skill already covers.
2. Discover before you write: get_site, read_site_settings, list_pages,
   list_block_types. Never hardcode block ids or field names — they're per-site.
3. THE BUFFER MODEL: every content write (pages, blocks, partials,
   collection items) lands in an unsaved per-doc DRAFT — deploys and plain
   previews see saved content only. Iterate freely, view your drafts with
   include_working_copy on the preview tools, then SAVE explicitly:
   commit_working_copy (or save:true on the write call) when the user
   approves. Status changes and structural ops apply immediately.
4. Branch first for anything larger than a small edit: create_branch, pass
   version=<id> on every subsequent call, merge_branch once approved. Nothing
   touches the live site until then.
5. Pages default to block mode. Build with add_block/update_block; make layouts
   responsive per breakpoint with set_block_responsive (grid columns, icon-box
   layout, … take { mobile, tablet, laptop, desktop, wide } values).
6. No site yet? With an org-scoped key, create_site bootstraps one.

If anything here conflicts with what a tool returns, trust the tool. Every
tool's own description carries its specifics.
`.trim();

export function buildServer(options: BuildServerOptions): McpServer {
  if (!options.fixedSiteId && !options.allowedSites) {
    throw new Error('buildServer: either fixedSiteId or allowedSites must be provided');
  }
  if (options.fixedSiteId && options.allowedSites) {
    throw new Error('buildServer: provide only one of fixedSiteId / allowedSites');
  }

  const server = new McpServer(options.info ?? DEFAULT_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  const allTools: ToolDef[] = [
    ...skillTools,
    ...siteTools,
    ...pageTools,
    ...partialTools,
    ...blockTypeTools,
    ...pageBlockTools,
    ...workingCopyTools,
    ...collectionTools,
    ...mediaTools,
    ...redirectTools,
    ...migrationTools,
    ...formTools,
    ...settingsTools,
    ...appTools,
    ...funnelAttributionTools,
    ...searchTools,
    ...bulkTools,
    ...versionTools,
    ...deployTools,
    ...previewTools,
    ...domainTools,
  ];

  // SDK's registerTool has deeply-nested generics we can't unify across a
  // heterogeneous tool list at compile time — same shrug as stdio's index.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = (server as any).registerTool.bind(server) as (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: { description: string; inputSchema?: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (args: any) => unknown,
  ) => unknown;

  const isMultiSite = !!options.allowedSites;
  const allowedById = new Map<string, AllowedSite>(
    (options.allowedSites ?? []).map((s) => [s.siteId, s]),
  );

  for (const tool of allTools) {
    const effect = effectFor(tool.name);
    // Skill-discovery tools (and any future site-less tool) operate without a
    // site context: don't inject or validate a `site_id` arg for them.
    const needsSite = !tool.noSite;

    let schema: ZodRawShape | undefined = tool.inputSchema;
    if (isMultiSite && needsSite) {
      // Append site_id to the tool's existing input schema. We mutate a copy
      // so we don't pollute the imported ToolDef.
      const siteIdField = {
        site_id: z
          .string()
          .describe(
            `Required. The id of the site this call targets. Use list_sites to discover ids; available sites for this connection: ${
              (options.allowedSites ?? []).map((s) => s.siteId).join(', ') || '(none)'
            }.`,
          ),
      };
      schema = { ...(tool.inputSchema ?? {}), ...siteIdField };
    }

    register(
      tool.name,
      {
        description: tool.description,
        ...(schema ? { inputSchema: schema } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const rawArgs = args ?? {};
        let siteId: string;
        if (isMultiSite && needsSite) {
          const provided = typeof rawArgs.site_id === 'string' ? rawArgs.site_id.trim() : '';
          if (!provided) {
            return fail(
              new Error(
                'site_id is required. This connector covers multiple sites; pick one from list_sites.',
              ),
            );
          }
          const match = allowedById.get(provided);
          if (!match) {
            return fail(
              new Error(
                `site_id "${provided}" is not accessible by this connection. Use list_sites to see allowed ids.`,
              ),
            );
          }
          if (PERM_RANK[match.permission] < PERM_RANK[effect]) {
            return fail(
              new Error(
                `Tool "${tool.name}" requires ${effect} permission on site "${provided}"; this connection has ${match.permission}.`,
              ),
            );
          }
          siteId = provided;
          // Strip site_id from the args we pass downstream so individual
          // tool schemas (which don't declare it) don't reject the call.
          delete rawArgs.site_id;
        } else {
          // Single-site mode, or a site-less tool in multi-site mode (no
          // fixedSiteId) — the latter's handler ignores siteId entirely.
          siteId = options.fixedSiteId ?? '';
        }
        const deps: ToolDeps = { client: options.client, siteId };
        return tool.handler(rawArgs, deps);
      },
    );
  }

  return server;
}
