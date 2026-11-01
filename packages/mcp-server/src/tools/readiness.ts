// Site launch readiness. One read-only report of what the site needs to be
// found, shared and understood; every item has a fix and a guide link.

import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

export const readinessTools: ToolDef[] = [
  {
    name: 'read_site_readiness',
    description:
      'Read-only launch readiness report for the selected site and version: share image, home page description, organization and profile links, favicon, analytics and consent, Search Console, privacy and contact pages, indexable and orphan pages, duplicate titles and descriptions, H1 per page, description length, duplicate font loads, custom CSS that overrides the theme, conflicts between the site\'s ai_crawler_policy and the Cloudflare zone\'s AI crawler settings, and page JSON-LD problems. ' +
      'Returns {site_id, checked_at, summary:{ok, suggestions, warnings}, items:[{id, status, message, fix, guide, details?}]}. Items are warnings or suggestions, never blockers; a missing default share image is a suggestion. ' +
      'Run it before launch and after larger changes, then fix or record each open item. It reads the Cloudflare zone only when the existing connection already may; it never changes zone settings or content.',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) =>
      ok(await client.get(siteId, 'readiness', args.version ? { version: args.version } : undefined))),
  },
];
