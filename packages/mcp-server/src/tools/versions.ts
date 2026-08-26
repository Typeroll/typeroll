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
      "Create a copy-on-write branch from main (or the version passed in `base`) — the RECOMMENDED first step for any larger or experimental change (redesigns, multi-page edits, trying a new design direction). Work lands on the branch, never on the live main version, until you merge_branch it. New branches default to robots_blocked:true (a half-finished design can't be indexed) and get their own deploy URL ({branch}.{project}.pages.dev) for stakeholder review. Pass the returned id as ?version= on every subsequent read/write. When in doubt, branch — it's cheap and keeps the live site safe. The tr-redesign-branch skill (read_skill) walks the full flow.",
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
    description: 'Discard a branch (main cannot be deleted).',
    inputSchema: { version_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, `versions/${encodeURIComponent(args.version_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'merge_branch',
    description:
      'Promote a branch\'s overrides + tombstones onto main. The branch is left in place so you can keep iterating; delete_branch removes it when you\'re done.',
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
