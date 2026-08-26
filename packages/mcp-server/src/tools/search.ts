import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const searchTools: ToolDef[] = [
  {
    name: 'search_pages',
    description:
      'Search page bodies by literal substring or regex. Returns up to 500 matches each with an excerpt around the first hit. Use this to scope a redesign or a bulk replacement before running it. ' +
      'Pass either "contains" (case-insensitive literal) or "regex" (JS regex source without slashes) — not both. ' +
      'Example: search_pages({"contains": "kontakta oss"}) finds every page mentioning that phrase. ' +
      'Example: search_pages({"regex": "\\\\d{3}-\\\\d{3}"}) finds pages with phone-number patterns.',
    inputSchema: {
      contains: z.string().optional().describe('Case-insensitive literal substring. Example: "kontakta oss"'),
      regex: z.string().optional().describe('JS regex source without surrounding slashes, case-insensitive. Example: "\\\\d{3}-\\\\d{3}" matches phone patterns.'),
      limit: z.number().int().min(1).max(500).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...query } = args;
      const res = await client.get(siteId, 'search', { ...query, ...v(version) });
      return ok(res);
    }),
  },
];
