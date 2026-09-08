import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const previewTools: ToolDef[] = [
  {
    name: 'revoke_preview_link',
    description: 'Revoke one previously issued preview link. Page access stops immediately; any media read URLs already issued expire within 60 seconds. Does not affect other preview links.',
    inputSchema: { preview_url: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const token = new URL(args.preview_url).searchParams.get('t');
      if (!token) throw new Error('Expected a signed preview URL.');
      return ok(await client.post(siteId, 'preview-link/revoke', { token }));
    }),
  },
  {
    name: 'get_preview_link',
    description:
      'Mint a signed URL the user (or your own browser tool) can open to SEE the rendered preview. Renders LIVE from the database with NO build — this is the PREFERRED way to preview design/content changes as you iterate; reach for this, not trigger_deploy, when previewing. BUFFER MODEL: your edits are unsaved drafts, so for the iteration loop mint the link with include_working_copy:true (drafts visible); a plain link shows SAVED content only — right for stakeholders reviewing what will deploy. Mint ONCE and REUSE that single URL across edits — internal links keep the token so it navigates the whole branch, and it stays valid until the TTL lapses (24h default and max). Target a page (page_id), a collection item (collection_name + item_id), or a raw slug; omit all for the home page. (For a permanent public link, complete Publishing setup and wait for a verified deployment on the organization or site domain.)',
    inputSchema: {
      page_id: z.string().optional(),
      slug: z.string().optional(),
      collection_name: z.string().optional(),
      item_id: z.string().optional(),
      ttl_seconds: z.number().int().min(60).max(86_400).optional(),
      include_working_copy: z
        .boolean()
        .optional()
        .describe(
          'Render unsaved drafts (working copies) too — yours AND the editor\'s. Off by default (saved content only). Signed into the token, so a draft link needs its own mint. Use this for your own iteration loop; use a plain link when the user wants to see exactly what a deploy would ship.',
        ),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'preview-link', body, v(version));
      return ok(res);
    }),
  },
];
