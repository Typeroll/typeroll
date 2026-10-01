// Workflow tools — the portal's server-side workflows (WordPress migration,
// AI site planning, SEO / link / performance audits, content generation and
// improvement, schema markup, URL parity, rebuild & deploy) and creating a
// Site together with its first workflow.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef } from './helpers.js';

const WORKFLOW_TYPES = [
  'migration', 'site_planning', 'seo_audit', 'content_improvement', 'link_check',
  'performance_audit', 'content_generation', 'schema_markup', 'url_parity', 'rebuild_deploy',
] as const;

export const workflowTools: ToolDef[] = [
  {
    name: 'list_workflows',
    description: 'List the workflow types this Site can run (label, description, steps, required_permission) and its most recent runs with status. Read only. Migration, site planning and URL parity pause for review; check get_workflow for paused_for_review.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'workflows', args.limit ? { limit: args.limit } : undefined))),
  },
  {
    name: 'start_workflow',
    description: 'Start a server-side workflow on this Site; it runs in the background and returns workflow_id. Poll get_workflow. Config per type (same fields as the portal form): migration { wp_url, helper_api_key? } (needs verified organization import storage); site_planning { business_description }; content_generation { topic, tone?, audience? }; content_improvement { limit? }; url_parity { target_origin?, source_origin?, check_source?, statuses? }; rebuild_deploy { environment: staging | production }; seo_audit, link_check, performance_audit and schema_markup take none. Needs write permission; rebuild_deploy publishes and needs admin. Workflows that change content write to the given version (default main) — get the user\'s agreement first.',
    inputSchema: {
      type: z.enum(WORKFLOW_TYPES),
      config: z.record(z.unknown()).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) =>
      ok(await client.post(siteId, 'workflows', { type: args.type, config: args.config }, args.version ? { version: args.version } : undefined))),
  },
  {
    name: 'get_workflow',
    description: 'Read one workflow run: status (pending | running | paused_for_review | completed | failed), current step, progress, log, review_message/review_data when paused, results and failure_reason. Credential config is masked.',
    inputSchema: { workflow_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `workflows/${encodeURIComponent(args.workflow_id)}`))),
  },
  {
    name: 'approve_workflow',
    description: 'Approve the review gate of a run that is paused_for_review; it resumes from the next step in the background. Show the user review_message and review_data from get_workflow and get their approval first — approval is theirs to give, not the tool\'s. Write permission; any other status returns 409.',
    inputSchema: { workflow_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, `workflows/${encodeURIComponent(args.workflow_id)}/approve`))),
  },
  {
    name: 'create_site_and_migrate',
    noSite: true,
    description: 'Create a new Site in the Organization and start a WordPress migration into it, like "Migrate from WordPress" on the portal\'s New site page. Requires an organization API key and verified organization import storage (409 import_storage_required otherwise — nothing is created). Returns site and workflow ids; poll get_workflow with that site_id. Run get_migration_readiness on the new Site if you need the preflight first.',
    inputSchema: {
      name: z.string().min(1).describe('Site display name; slugified into the Site id.'),
      wp_url: z.string().url().describe('Public WordPress address, e.g. https://oldsite.example.'),
      helper_api_key: z.string().optional().describe('Typeroll Helper plugin key from the WordPress admin, if installed. Stored for the run and never returned.'),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('sites/create-and-migrate', args))),
  },
  {
    name: 'create_site_and_plan',
    noSite: true,
    description: 'Create a new Site in the Organization and start AI site planning from a business description, like "Plan a new site with AI" on the New site page. Requires an organization API key. The plan pauses for review: read it with get_workflow and approve_workflow only after the user agrees.',
    inputSchema: {
      name: z.string().min(1),
      business_description: z.string().min(1).describe('What the business does, for whom, and what sets it apart.'),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('sites/create-and-plan', args))),
  },
];
