import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const bulkTools: ToolDef[] = [
  {
    name: 'bulk_replace_text',
    description:
      'Replace a literal substring or regex across pages in one call. ALWAYS run with dry_run=true first and show the sample_diffs to the user before running the real call. BUFFER MODEL: replacements land in each page\'s unsaved DRAFT; after the user approves the diffs, run with save:true to commit each touched page (revision snapshots + SEO transforms included). Response: { dry_run, updated, saved, total_matches, pages_with_matches, sample_diffs_shown, additional_pages_with_matches, sample_diffs[], skipped (deprecated) }.',
    inputSchema: {
      pattern: z.string().min(1).describe('Literal substring (default) or JS regex source if regex=true.'),
      replacement: z.string(),
      regex: z.boolean().optional().describe('Treat pattern as a regex source. Always case-insensitive + global.'),
      page_ids: z.array(z.string()).optional().describe('Restrict to these page ids. Omit to apply to every matching page.'),
      dry_run: z.boolean().optional(),
      save: z.boolean().optional().describe('Commit every touched page\'s draft in the same call — the usual choice after the user approved the dry-run diffs.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'bulk-replace', body, v(version));
      return ok(res);
    }),
  },
];
