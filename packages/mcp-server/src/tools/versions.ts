// Version (branch) tools.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const versionTools: ToolDef[] = [
  {
    name: 'list_versions',
    description: 'List versions (main + branches).',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'versions');
      return ok(res);
    }),
  },
  {
    name: 'create_branch',
    description:
      "Create a copy-on-write branch from main (or the version passed in `base`) — the RECOMMENDED first step for any larger or experimental change (redesigns, multi-page edits, trying a new design direction). Work lands on the branch, never on the live main version, until you merge_branch it. New branches default to robots_blocked:true (a half-finished design can't be indexed) and get their own stable deploy address for stakeholder review: after the branch's first trigger_deploy, read it from deploy_url in list_versions or read_version (the publishing setup decides the host: under a Hosting Group it is a v-… host under that group's site address base, otherwise the address the host reported; never construct it yourself). Pass the returned id as ?version= on every subsequent read/write. When in doubt, branch — it's cheap and keeps the live site safe. The tr-redesign-branch skill (read_skill) walks the full flow. Admin permission on the site is required, as in the portal.",
    inputSchema: {
      name: z.string().min(1),
      base: z.string().optional().describe('Source version id; defaults to main.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'versions', args);
      return ok(res);
    }),
  },
  {
    name: 'read_version',
    description: 'Read one version\'s metadata.',
    inputSchema: { version_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `versions/${encodeURIComponent(args.version_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'delete_branch',
    description: 'Discard a branch with its overrides, tombstones and revision history (main cannot be deleted). Admin permission required.',
    inputSchema: { version_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, `versions/${encodeURIComponent(args.version_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'diff_version',
    description:
      'Read-only: what a branch changes relative to main, per collection (pages, partials, redirects, contentTypes, pageTemplates, blockTypes): ids it adds, modifies and deletes, plus whether it overrides site settings and totalChanges. This is exactly what merge_branch would land on main and what reset_version would discard. Use it to summarise a branch for review before asking for merge approval.',
    inputSchema: { version_id: z.string().describe('Branch id (main has nothing to diff).') },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `versions/${encodeURIComponent(args.version_id)}/diff`);
      return ok(res);
    }),
  },
  {
    name: 'reset_version',
    description:
      'Discard EVERY change on a branch (all overrides and deletions), so it reads straight through to main again. The branch itself, its deploy address and its revision history are kept. Destructive for the branch\'s work: run diff_version first and get explicit user approval. Returns { cleared } — the diff that was discarded. Admin permission required. Main cannot be reset.',
    inputSchema: { version_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, `versions/${encodeURIComponent(args.version_id)}/reset`);
      return ok(res);
    }),
  },
  {
    name: 'merge_branch',
    description:
      'Promote a branch\'s overrides + tombstones onto main (diff_version shows exactly what will land). The branch is left in place so you can keep iterating; delete_branch removes it when you\'re done. Admin permission required.',
    inputSchema: { version_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `versions/${encodeURIComponent(args.version_id)}/merge`,
      );
      return ok(res);
    }),
  },
];
