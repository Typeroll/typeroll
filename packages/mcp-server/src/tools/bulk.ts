import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const bulkTools: ToolDef[] = [
  {
    name: 'check_internal_links',
    description:
      'Check internal hrefs against the versioned database before deploy. Covers published Pages of every content type, partials, Page templates, generated facet routes, media URLs and redirect chains. Returns every broken source/href pair without requesting the live site.',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.get(siteId, 'internal-links', v(args.version)));
    }),
  },
  {
    name: 'bulk_replace_text',
    description:
      'Replace a literal substring or regex across Page bodies, custom Page fields, and partials. ALWAYS run with dry_run=true first and show sample_diffs before the real call. Defaults to scope=pages. BUFFER MODEL: replacements land in unsaved DRAFTS; save=true commits each touched resource through the canonical save path.',
    inputSchema: {
      pattern: z.string().min(1).describe('Literal substring (default) or JS regex source if regex=true.'),
      replacement: z.string(),
      regex: z.boolean().optional().describe('Treat pattern as a regex source. Always case-insensitive + global.'),
      scope: z.enum(['pages', 'partials', 'all']).optional().describe('Resource family to scan. Defaults to pages.'),
      page_ids: z.array(z.string()).optional().describe('Restrict to these page ids. Omit to apply to every matching page.'),
      content_type: z.string().optional().describe('Restrict replacement to Pages of this content type.'),
      partial_ids: z.array(z.string()).optional().describe('Restrict to partial ids.'),
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
