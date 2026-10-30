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
      'Create a redirect rule, or update the rule that already has this from_path in place (same id, no gap). ' +
      'Defaults to 301; pass status_code=302 for a temporary redirect. ' +
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
    name: 'update_redirect',
    description:
      'Change the target or status code of an existing redirect rule in place. The id and from_path stay the same ' +
      'and the source path keeps redirecting throughout. To change from_path, create a new rule and delete the old one.',
    inputSchema: {
      redirect_id: z.string().describe('Rule id from list_redirects.'),
      to_path: z.string().optional().describe('New target path or absolute URL.'),
      status_code: z.union([z.literal(301), z.literal(302)]).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { redirect_id, version, ...body } = args;
      const res = await client.patch(siteId, `redirects/${encodeURIComponent(redirect_id)}`, body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'upsert_redirects',
    description:
      'Create or update up to 1000 redirect rules in one call, keyed by from_path: an existing rule keeps its id and is ' +
      'replaced in place, so no address is ever without a rule. Every rule is validated against the site and against the ' +
      'batch as a whole (loops, hidden live pages); if any rule fails, nothing is written. Pass dry_run=true first to see ' +
      'per-rule create/update/unchanged results and warnings without writing. capacity reports the Cloudflare Pages rules ' +
      'the site emits afterwards (2000 static, 100 dynamic per site, shared by page redirects and old file addresses); ' +
      'heed capacity.warning before publishing.',
    inputSchema: {
      redirects: z.array(z.object({
        from_path: z.string(),
        to_path: z.string(),
        status_code: z.union([z.literal(301), z.literal(302)]).optional(),
      })).min(1).max(1000),
      dry_run: z.boolean().optional().describe('Validate and report without writing.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.put(siteId, 'redirects', body, v(version));
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
