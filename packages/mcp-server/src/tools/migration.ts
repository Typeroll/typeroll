import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

const STATUS = z.enum(['migrated', 'redirected', 'excluded', 'unhandled']);

export const migrationTools: ToolDef[] = [
  {
    name: 'import_sitemap',
    description:
      'Import an explicit sitemap URL into the migration URL inventory. Sitemap indexes are followed recursively; URLs outside source_origin are rejected and reported.',
    inputSchema: {
      url: z.string().url().describe('Absolute URL of a sitemap or sitemap index.'),
      source_origin: z.string().url().optional().describe('Expected legacy-site origin. Defaults to the sitemap origin.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.post(siteId, 'migration-urls/import-sitemap', args));
    }),
  },
  {
    name: 'import_gsc_performance',
    description:
      'Import URL metrics from Google Search Console. Use property for a direct server-side Search Console API query, or csv for the manual export fallback. URL fragments are stripped, duplicate metrics are summed, and previously unknown URLs enter the inventory as unhandled.',
    inputSchema: {
      property: z.string().optional().describe('Search Console property, e.g. https://example.com/ or sc-domain:example.com.'),
      months: z.number().int().min(1).max(16).optional(),
      csv: z.string().optional().describe('Raw Search Console Pages CSV export.'),
      source_origin: z.string().url().optional().describe('Legacy-site origin. Required for bare CSV paths or sc-domain properties.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      if ((typeof args.property === 'string') === (typeof args.csv === 'string')) {
        throw new Error('Provide exactly one of property or csv.');
      }
      return ok(await client.post(siteId, 'migration-urls/import-gsc', args));
    }),
  },
  {
    name: 'get_migration_readiness',
    description:
      "Preflight for an import: is this site actually ready to receive a migration? CALL THIS FIRST, before moving any content. Every check exists because its failure is INVISIBLE afterwards — the pages import, the previews render, the customer signs off, and something is quietly wrong. The blockers: media storage (without it every <img> keeps its original URL, so the shiny new site is still served images by the old host, and the day that hosting is cancelled every image breaks at once) and the hosting adapter (without credentials, deploys return a job id and publish nothing while reporting success). Warnings cover the pre-cutover verification URL, AI reconstruction, form notification email and whether the target has a design to rebuild INTO. Returns { ready, blockers[], warnings[], checks[] } — each with a `fix`. If `ready` is false, stop and report the blockers to the user rather than starting the import; the content work would have to be redone.",
    inputSchema: {
      source_url: z
        .string()
        .optional()
        .describe('The site you are migrating FROM, e.g. "https://oldsite.com". When given, the source is probed too: unreachable or bot-blocked (403/429) is a BLOCKER because an import from a host that refuses our requests produces empty pages, and whether /wp-json answers is reported as a warning (without it the importer must scrape HTML and loses ACF/custom fields).'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        'migration-preflight',
        args.source_url ? { source_url: args.source_url } : undefined,
      );
      return ok(res);
    }),
  },
  {
    name: 'list_migration_urls',
    description:
      "The legacy site's URL inventory with LIVE coverage status. Every entry is classified on read against the site's current pages + redirects: `migrated` (a page/collection item answers at that path), `redirected` (a redirect rule covers it), `excluded` (signed off as an intentional 404), `unhandled` (nothing covers it — the work list). Returns a summary over the whole inventory plus a page of entries, sorted worst-first then by GSC clicks. Use `status: \"unhandled\"` to get exactly what's left to do before cutover. Coverage is computed, never stored, so it's current the moment you create a redirect.",
    inputSchema: {
      status: STATUS.optional().describe('Only return entries with this coverage status.'),
      limit: z.number().int().positive().max(1000).optional().describe('Default 200.'),
      offset: z.number().int().min(0).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'migration-urls', {
        status: args.status,
        limit: args.limit,
        offset: args.offset,
      });
      return ok(res);
    }),
  },
  {
    name: 'add_migration_urls',
    description:
      "Add old-site URLs to the inventory in bulk (up to 2000 per call). This is how the inventory gets populated outside the in-portal WordPress migration: walk the old sitemap.xml, a GSC export, or a crawl, and post what you found. Idempotent — re-posting a known URL merges its `source` label instead of duplicating. Pass `source_origin` when the site you're inventorying has its own domain: absolute URLs from a different origin are then REJECTED rather than silently folded in, which is what keeps a ten-domain multisite migration from pouring domain B's `/kontakt` into domain A's inventory. Rejected entries come back with a reason — nothing is dropped silently.",
    inputSchema: {
      urls: z
        .array(
          z.object({
            url: z.string().describe('Absolute URL (preferred) or a bare path like "/om-oss".'),
            source: z.string().optional().describe('Where you found it: "sitemap", "gsc", "crawl", "manual", …'),
            notes: z.string().optional(),
            gsc_clicks: z.number().optional().describe('Search Console clicks — drives prioritisation in the coverage report.'),
            gsc_impressions: z.number().optional(),
            excluded: z.boolean().optional().describe('Mark immediately as an intentional 404 (e.g. /wp-admin, tag archives you are dropping).'),
          }),
        )
        .min(1)
        .max(2000),
      source: z.string().optional().describe('Default source label for entries that omit one.'),
      source_origin: z
        .string()
        .optional()
        .describe('Origin of the old site, e.g. "https://old.example.com". Rejects absolute URLs from other origins.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'migration-urls', args);
      return ok(res);
    }),
  },
  {
    name: 'update_migration_url',
    description:
      'Annotate one inventory entry. `excluded: true` is the sign-off that this URL is MEANT to 404 after cutover — it moves the entry out of the "unhandled" work list without inventing a redirect for it. Also accepts notes and GSC metrics. The url_id is the entry id from list_migration_urls (the path with slashes replaced by underscores).',
    inputSchema: {
      url_id: z.string(),
      excluded: z.boolean().optional(),
      notes: z.string().optional(),
      gsc_clicks: z.number().optional(),
      gsc_impressions: z.number().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { url_id, ...patch } = args;
      const res = await client.patch(siteId, `migration-urls/${encodeURIComponent(url_id)}`, patch);
      return ok(res);
    }),
  },
  {
    name: 'update_migration_urls',
    description:
      'Apply one shared patch to many inventory entries in a single API request. Select either `ids` (up to 2000) or `where: { source }`, never both. This is the migration-scale path for decisions such as “every wordpress-redirect-guess URL is an intentional 404”; it avoids hundreds of rate-limited PATCH calls. Returns matched/updated/unchanged counts, unknown ids, and the refreshed coverage summary.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(2000).optional(),
      where: z.object({ source: z.string().min(1) }).optional(),
      patch: z.object({
        excluded: z.boolean().optional(),
        notes: z.string().optional(),
        gsc_clicks: z.number().nonnegative().optional(),
        gsc_impressions: z.number().nonnegative().optional(),
      }).refine((value) => Object.keys(value).length > 0, 'patch must include at least one writable field'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      if ((args.ids ? 1 : 0) + (args.where ? 1 : 0) !== 1) {
        throw new Error('Provide exactly one selector: ids or where');
      }
      const res = await client.patch(siteId, 'migration-urls', args);
      return ok(res);
    }),
  },
  {
    name: 'delete_migration_url',
    description:
      'Remove an entry from the inventory entirely. Use for junk the crawl picked up (session URLs, faceted duplicates). To record a deliberate 404 instead, prefer update_migration_url with excluded: true — that keeps the decision visible in the coverage report.',
    inputSchema: { url_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, `migration-urls/${encodeURIComponent(args.url_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'verify_migration_urls',
    description:
      "Pre-cutover parity check: actually REQUEST every inventory URL against the new site and report what it answers. list_migration_urls tells you what the data says; this tells you what the server does — a redirect pointing at an unpublished page, a typo'd path, or a redirect loop all read as \"handled\" in coverage and as a 404 to Googlebot. Runs against the site's fallback subdomain by default. The response is compact by default: the full summary plus only `missing`, `broken_redirect`, and `error` rows; successful rows are counted but omitted. Pass `verdicts` for an exact result filter or `include_successes: true` for every row. Canonical trailing-slash normalization counts as `ok`, not `ok_redirect`. Also stamps verified/last_checked on redirect rules it exercised. Deploy before running this — it tests the DEPLOYED site, not your drafts.",
    inputSchema: {
      target_origin: z
        .string()
        .optional()
        .describe('Origin to test, e.g. "https://acme.sites.typeroll.com". Defaults to the site\'s fallback subdomain, then its live domain.'),
      source_origin: z.string().optional().describe('Old site origin, e.g. "https://old.example.com".'),
      check_source: z
        .boolean()
        .optional()
        .describe('Also request each path on the OLD site (requires source_origin), so a URL that already 404s upstream is distinguishable from one the migration lost. Doubles the request count.'),
      statuses: z
        .array(STATUS)
        .optional()
        .describe('Only check entries with these coverage statuses. Default: all — "migrated" is exactly the claim this check exists to falsify.'),
      verdicts: z
        .array(z.enum(['ok', 'ok_redirect', 'missing', 'broken_redirect', 'error', 'excluded']))
        .optional()
        .describe('Only return rows with these verdicts. The summary still covers every checked URL.'),
      include_successes: z
        .boolean()
        .optional()
        .describe('Return all rows when verdicts is omitted. Default false: successful/excluded rows are summarized but omitted.'),
      limit: z.number().int().positive().max(500).optional().describe('Max URLs per run (default 150). `truncated: true` in the response means there are more.'),
      concurrency: z.number().int().positive().max(12).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'migration-urls/verify', args);
      return ok(res);
    }),
  },
];
