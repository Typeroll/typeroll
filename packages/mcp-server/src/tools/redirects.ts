import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const redirectTools: ToolDef[] = [
  {
    name: 'list_redirects',
    description: 'List redirect rules (from_path → to_path, status code).',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'redirects', v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'create_redirect',
    description:
      'Create a redirect rule. Defaults to 301; pass status_code=302 for a temporary redirect. ' +
      'WILDCARDS: a trailing "*" captures everything under a prefix and ":splat" replays it into the ' +
      'target — `from_path="/category/*", to_path="/blogg/:splat"` retires an entire WordPress taxonomy ' +
      'in one rule. `:name` matches exactly one segment (`"/blog/:slug"` → `"/artiklar/:slug"`). ' +
      'Rules that would hide a live page are refused (Cloudflare applies redirects before serving files, ' +
      'so the page would become unreachable) — narrow the pattern. QUERY STRINGS: an exact source such as ' +
      '`/?p=123` or `/index.php?page_id=5` with a fixed to_path is published as an in-page script redirect ' +
      '(not a 301), because `_redirects` matches paths only; extra parameters such as utm_* are ignored.',
    inputSchema: {
      from_path: z.string().describe('Old path, leading slash (e.g. "/old-about"). May be a pattern: "/category/*" (trailing splat only) or "/blog/:slug" (one segment), or a literal path with exact query parameters ("/?p=123").'),
      to_path: z.string().describe('Target path or absolute URL. May reference ":splat" (requires a "*" in from_path) or any ":name" from_path declares.'),
      status_code: z.union([z.literal(301), z.literal(302)]).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'redirects', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'delete_redirect',
    description: 'Remove a redirect rule.',
    inputSchema: { redirect_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `redirects/${encodeURIComponent(args.redirect_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
];
